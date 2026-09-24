import { describe, it, expect } from "vitest";
import { stripUndefined, MemoryStore } from "../src/remote/store.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

// ---------------------------------------------------------------------------
// stripUndefined
// ---------------------------------------------------------------------------

describe("stripUndefined", () => {
  it("removes top-level undefined fields", () => {
    const input = { a: 1, b: undefined, c: "hello" };
    const result = stripUndefined(input);
    expect(result).toEqual({ a: 1, c: "hello" });
    expect("b" in result).toBe(false);
  });

  it("removes nested undefined fields", () => {
    const input = { outer: { x: 1, y: undefined }, z: undefined };
    const result = stripUndefined(input);
    expect(result).toEqual({ outer: { x: 1 } });
    expect("y" in (result as Record<string, unknown>).outer).toBe(false);
  });

  it("preserves null and zero and empty string", () => {
    const input = { a: null, b: 0, c: "", d: false };
    expect(stripUndefined(input)).toEqual({ a: null, b: 0, c: "", d: false });
  });

  it("passes through primitives unchanged", () => {
    expect(stripUndefined(42)).toBe(42);
    expect(stripUndefined("hi")).toBe("hi");
    expect(stripUndefined(null)).toBe(null);
  });

  it("handles arrays without removing elements", () => {
    const input = { items: [1, 2, 3], tag: undefined };
    const result = stripUndefined(input);
    expect(result).toEqual({ items: [1, 2, 3] });
    expect("tag" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MemoryStore.createClient with undefined optional fields
// ---------------------------------------------------------------------------

describe("MemoryStore.createClient with undefined optional metadata", () => {
  it("stores and retrieves a client whose optional fields are undefined", async () => {
    const store = new MemoryStore();

    // Simulate what the MCP SDK DCR handler hands us: optional fields present
    // as undefined rather than absent.
    const client = {
      client_id: "test-client-001",
      client_secret: "secret-abc",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      // Optional fields explicitly undefined (as the SDK may set them)
      client_name: undefined,
      client_uri: undefined,
      logo_uri: undefined,
      contacts: undefined,
      tos_uri: undefined,
      policy_uri: undefined,
      jwks_uri: undefined,
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: undefined,
    } as unknown as OAuthClientInformationFull;

    // Must not throw
    await expect(store.createClient(client)).resolves.toBeUndefined();

    const retrieved = await store.getClient("test-client-001");
    expect(retrieved).toBeDefined();
    expect(retrieved!.client_id).toBe("test-client-001");
    expect(retrieved!.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  it("registers a client via the store and retrieves it", async () => {
    const store = new MemoryStore();
    const client: OAuthClientInformationFull = {
      client_id: "client-002",
      client_secret: "s3cr3t",
      redirect_uris: ["https://example.com/callback"],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };
    await store.createClient(client);
    const got = await store.getClient("client-002");
    expect(got).toMatchObject({ client_id: "client-002" });
  });
});

describe("single-use credentials", () => {
  it("consumes an authorization code at most once under concurrent requests", async () => {
    const store = new MemoryStore();
    await store.createAuthCode({
      codeHash: "code", clientId: "client", codeChallenge: "challenge",
      redirectUri: "https://example.com/callback", sub: "user", scopes: ["sheets"],
      resource: "https://example.com/mcp", expiresAt: Date.now() + 60_000,
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.takeAuthCode("code")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("consumes a refresh token at most once under concurrent requests", async () => {
    const store = new MemoryStore();
    await store.createRefreshToken({
      tokenHash: "refresh", clientId: "client", sub: "user", scopes: ["sheets"],
      resource: "https://example.com/mcp", expiresAt: Date.now() + 60_000,
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.takeRefreshToken("refresh")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
