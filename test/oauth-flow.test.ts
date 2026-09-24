import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import {
  buildApp,
  registerClient,
  authorizeUntilCode,
  challengeFor,
  mockGoogle,
  CLIENT_REDIRECT,
} from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("dynamic client registration + authorize", () => {
  it("registers a client and redirects /authorize to Google with correct params", async () => {
    const ctx = buildApp();
    const reg = await registerClient(ctx.app);
    expect(reg.status).toBe(201);
    expect(reg.body.client_id).toBeTruthy();

    const verifier = "verifier-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFatta";
    const codeChallenge = await challengeFor(verifier);

    const authRes = await request(ctx.app)
      .get("/authorize")
      .query({
        response_type: "code",
        client_id: reg.body.client_id,
        redirect_uri: CLIENT_REDIRECT,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: "abc123",
        scope: "sheets",
        resource: "https://mcp.example.com/mcp",
      });

    expect(authRes.status).toBe(302);
    const loc = new URL(authRes.headers.location);
    expect(loc.origin + loc.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(loc.searchParams.get("include_granted_scopes")).toBe("true");
    expect(loc.searchParams.get("hd")).toBe("example.com");
    const scope = loc.searchParams.get("scope") ?? "";
    expect(scope).toContain("https://www.googleapis.com/auth/spreadsheets");
    expect(scope).toContain("https://www.googleapis.com/auth/drive");
    // state is our opaque pending id, not the client's "abc123"
    const pendingId = loc.searchParams.get("state");
    expect(pendingId).toBeTruthy();
    expect(pendingId).not.toBe("abc123");
  });

  it("rejects missing or foreign MCP resource indicators", async () => {
    const ctx = buildApp();
    const reg = await registerClient(ctx.app);
    const query = {
      response_type: "code", client_id: reg.body.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: await challengeFor("verifier-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFatta"),
      code_challenge_method: "S256", scope: "sheets",
    };
    for (const resource of [undefined, "https://evil.example/mcp", "https://mcp.example.com/mcp/other"]) {
      const res = await request(ctx.app).get("/authorize").query({ ...query, resource });
      expect(res.status).toBe(302);
      const redirect = new URL(res.headers.location);
      expect(redirect.searchParams.get("error")).toBe("invalid_target");
    }
  });
});

describe("google callback domain enforcement", () => {
  it("allowed domain -> redirects to client with code + original state, stores user", async () => {
    const ctx = buildApp();
    const { cbRes, clientState } = await authorizeUntilCode(ctx, {
      email: "user@example.com",
      sub: "sub-allowed",
    });
    expect(cbRes.status).toBe(302);
    const redirect = new URL(cbRes.headers.location);
    expect(redirect.origin + redirect.pathname).toBe(CLIENT_REDIRECT);
    expect(redirect.searchParams.get("code")).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBe(clientState);
    expect(await ctx.store.getUser("sub-allowed")).toBeDefined();
  });

  it("disallowed domain -> 403 and no user stored", async () => {
    const ctx = buildApp();
    const { cbRes } = await authorizeUntilCode(ctx, {
      email: "intruder@evil.com",
      sub: "sub-denied",
    });
    expect(cbRes.status).toBe(403);
    expect(await ctx.store.getUser("sub-denied")).toBeUndefined();
  });
});

describe("/token authorization_code + PKCE", () => {
  async function redeem(
    ctx: ReturnType<typeof buildApp>,
    args: {
      clientId: string;
      clientSecret: string;
      code: string;
      verifier: string;
    }
  ) {
    return request(ctx.app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: args.code,
        redirect_uri: CLIENT_REDIRECT,
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code_verifier: args.verifier,
        resource: "https://mcp.example.com/mcp",
      });
  }

  it("valid verifier issues access + refresh; wrong verifier fails; reuse fails", async () => {
    const ctx = buildApp();
    const { clientId, clientSecret, verifier, cbRes } = await authorizeUntilCode(
      ctx,
      { email: "user@example.com" }
    );
    const code = new URL(cbRes.headers.location).searchParams.get("code")!;

    // Wrong verifier
    const bad = await redeem(ctx, {
      clientId,
      clientSecret,
      code,
      verifier: "totally-wrong-verifier-000000000000000000000000000000",
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    // Correct verifier
    const ok = await redeem(ctx, { clientId, clientSecret, code, verifier });
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toBeTruthy();
    expect(ok.body.refresh_token).toBeTruthy();
    expect(ok.body.token_type.toLowerCase()).toBe("bearer");

    // Reuse of the (now consumed) code fails
    const reuse = await redeem(ctx, { clientId, clientSecret, code, verifier });
    expect(reuse.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot exchange a read code for a full-access resource", async () => {
    const ctx = buildApp();
    const { clientId, clientSecret, verifier, cbRes } = await authorizeUntilCode(ctx, {
      email: "user@example.com", resource: "https://mcp.example.com/mcp/read",
    });
    const code = new URL(cbRes.headers.location).searchParams.get("code")!;
    const res = await request(ctx.app).post("/token").type("form").send({
      grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT,
      client_id: clientId, client_secret: clientSecret, code_verifier: verifier,
      resource: "https://mcp.example.com/mcp",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.access_token).toBeUndefined();
  });

  it("redeems an authorization code only once under concurrent HTTP requests", async () => {
    const ctx = buildApp();
    const { clientId, clientSecret, verifier, cbRes } = await authorizeUntilCode(ctx, {
      email: "user@example.com",
    });
    const code = new URL(cbRes.headers.location).searchParams.get("code")!;
    const responses = await Promise.all(Array.from({ length: 6 }, () =>
      redeem(ctx, { clientId, clientSecret, code, verifier })
    ));
    expect(responses.filter((res) => res.status === 200)).toHaveLength(1);
    expect(responses.filter((res) => res.status >= 400)).toHaveLength(5);
  });

  it("allows a read-resource OAuth token only at the read endpoint", async () => {
    const ctx = buildApp();
    const { clientId, clientSecret, verifier, cbRes } = await authorizeUntilCode(ctx, {
      email: "user@example.com", resource: "https://mcp.example.com/mcp/read",
    });
    const code = new URL(cbRes.headers.location).searchParams.get("code")!;
    const tokenRes = await request(ctx.app).post("/token").type("form").send({
      grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT,
      client_id: clientId, client_secret: clientSecret, code_verifier: verifier,
      resource: "https://mcp.example.com/mcp/read",
    });
    expect(tokenRes.status).toBe(200);
    const token = tokenRes.body.access_token as string;
    for (const [path, status] of [["/mcp/read", 200], ["/mcp/write", 401], ["/mcp", 401]] as const) {
      const res = await request(ctx.app).post(path)
        .set("Authorization", `Bearer ${token}`)
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect(res.status).toBe(status);
    }
  });

  it("defaults an omitted OAuth scope to sheets", async () => {
    const ctx = buildApp();
    const { clientId, clientSecret, verifier, cbRes } = await authorizeUntilCode(ctx, {
      email: "user@example.com", omitScope: true,
    });
    const code = new URL(cbRes.headers.location).searchParams.get("code")!;
    const tokenRes = await redeem(ctx, { clientId, clientSecret, code, verifier });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.scope).toBe("sheets");
    const mcpRes = await request(ctx.app).post("/mcp")
      .set("Authorization", `Bearer ${tokenRes.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(mcpRes.status).toBe(200);
  });
});

describe("/token refresh rotation", () => {
  it("rotates refresh tokens; the old one becomes invalid", async () => {
    const ctx = buildApp();
    const { clientId, clientSecret, verifier, cbRes } = await authorizeUntilCode(
      ctx,
      { email: "user@example.com" }
    );
    const code = new URL(cbRes.headers.location).searchParams.get("code")!;

    const first = await request(ctx.app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: CLIENT_REDIRECT,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      });
    expect(first.status).toBe(200);
    const refresh1 = first.body.refresh_token as string;

    const rotate = async (rt: string) =>
      request(ctx.app)
        .post("/token")
        .type("form")
        .send({
          grant_type: "refresh_token",
          refresh_token: rt,
          client_id: clientId,
          client_secret: clientSecret,
        });

    const second = await rotate(refresh1);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).toBeTruthy();
    expect(second.body.refresh_token).not.toBe(refresh1);

    // Old refresh token is now invalid
    const replay = await rotate(refresh1);
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot rotate a read refresh token into a full-access token", async () => {
    const ctx = buildApp();
    const { clientId, clientSecret, verifier, cbRes } = await authorizeUntilCode(ctx, {
      email: "user@example.com", resource: "https://mcp.example.com/mcp/read",
    });
    const code = new URL(cbRes.headers.location).searchParams.get("code")!;
    const first = await request(ctx.app).post("/token").type("form").send({
      grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT,
      client_id: clientId, client_secret: clientSecret, code_verifier: verifier,
    });
    expect(first.status).toBe(200);
    const escalated = await request(ctx.app).post("/token").type("form").send({
      grant_type: "refresh_token", refresh_token: first.body.refresh_token,
      client_id: clientId, client_secret: clientSecret,
      resource: "https://mcp.example.com/mcp",
    });
    expect(escalated.status).toBeGreaterThanOrEqual(400);
    expect(escalated.body.access_token).toBeUndefined();
  });
});
