import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { buildApp, authorizeUntilCode, CLIENT_REDIRECT } from "./helpers.js";
import { sha256 } from "../src/remote/crypto.js";
import { SCOPE_VERSION } from "../src/remote/config.js";

const EXPECTED_TOOLS = [
  // Sheets
  "list_spreadsheets",
  "get_spreadsheet",
  "create_spreadsheet",
  "add_sheet",
  "delete_sheet",
  "read_range",
  "batch_read",
  "write_range",
  "batch_write",
  "append_rows",
  "clear_range",
  "find_cells",
  "batch_update_raw",
  // Docs
  "list_documents",
  "get_document",
  "create_document",
  "append_text",
  "insert_text",
  "replace_text",
  "batch_update_docs_raw",
  // Slides
  "list_presentations",
  "get_presentation",
  "create_presentation",
  "add_slide",
  "replace_text_in_presentation",
  "insert_text_box",
  "insert_image",
  "delete_slide",
  "get_slide_thumbnail",
  "batch_update_slides_raw",
  // Forms
  "list_forms",
  "get_form",
  "create_form",
  "add_question",
  "update_form_info",
  "delete_item",
  "list_responses",
  "batch_update_forms_raw",
  // Apps Script
  "list_script_projects",
  "create_script_project",
  "get_script_project",
  "update_script_content",
  "list_script_versions",
  "create_script_version",
  "list_script_deployments",
  "create_script_deployment",
  "run_script_function",
  "get_script_processes",
];

/** Extract JSON-RPC messages from an SSE response body. */
function parseSse(body: string): any[] {
  const out: any[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (m && m[1]) {
      try {
        out.push(JSON.parse(m[1]));
      } catch {
        /* ignore non-JSON data lines */
      }
    }
  }
  return out;
}

/** Seed a valid access token bound to a user with the current scope version. */
async function seedToken(
  store: ReturnType<typeof buildApp>["store"],
  token: string,
  sub: string,
  scopeVersion: string | undefined
) {
  await store.upsertUser({
    sub,
    email: `${sub}@example.com`,
    refreshTokenEnc: "enc",
    updatedAt: Date.now(),
    scopeVersion,
  });
  await store.createAccessToken({
    tokenHash: sha256(token),
    sub,
    clientId: "client-1",
    scopes: ["sheets"],
    resource: "https://mcp.example.com/mcp",
    expiresAt: Date.now() + 3600_000,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("/mcp bearer auth", () => {
  it("rejects requests without a bearer token (401 + WWW-Authenticate)", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(401);
    const wwwAuth = res.headers["www-authenticate"];
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toContain(
      "resource_metadata=\"https://mcp.example.com/.well-known/oauth-protected-resource/mcp\""
    );
  });

  it("lists all Sheets + Docs + Slides + Forms + Apps Script tools with a valid bearer token", async () => {
    const { app, store } = buildApp();
    const token = "valid-access-token";
    await seedToken(store, token, "sub-1", SCOPE_VERSION);

    // Stateless mode (sessionIdGenerator: undefined) disables session
    // validation, so a bare tools/list needs no prior initialize handshake.
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(res.status).toBe(200);
    const messages = parseSse(res.text);
    const toolsMsg = messages.find((m) => m.id === 2);
    expect(toolsMsg, "tools/list response present").toBeTruthy();
    const names = (toolsMsg.result.tools as Array<{ name: string }>).map(
      (t) => t.name
    );
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });
});

describe("scope-version enforcement", () => {
  it("rejects /mcp with 401 when the user's scopeVersion is stale (old user)", async () => {
    const { app, store } = buildApp();
    const token = "stale-access-token";
    // Pre-versioning user: scopeVersion undefined.
    await seedToken(store, token, "sub-stale", undefined);

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBeTruthy();
  });

  it("rejects a refresh_token grant with invalid_grant when scopeVersion is stale", async () => {
    const ctx = buildApp();
    const { clientId, clientSecret, verifier, cbRes } = await authorizeUntilCode(
      ctx,
      { email: "user@example.com", sub: "sub-refresh" }
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
    const refreshToken = first.body.refresh_token as string;

    // Downgrade the user's scopeVersion, preserving the rest of the record.
    const user = await ctx.store.getUser("sub-refresh");
    expect(user).toBeDefined();
    await ctx.store.upsertUser({ ...user!, scopeVersion: "0" });

    const refreshRes = await request(ctx.app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });

    expect(refreshRes.status).toBeGreaterThanOrEqual(400);
    expect(refreshRes.body.error).toBe("invalid_grant");
  });
});
