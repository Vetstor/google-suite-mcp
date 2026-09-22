import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "./helpers.js";

describe("well-known metadata", () => {
  it("serves authorization-server metadata with BASE_URL", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.body.issuer.replace(/\/$/, "")).toBe("https://mcp.example.com");
    expect(res.body.authorization_endpoint).toBe("https://mcp.example.com/authorize");
    expect(res.body.token_endpoint).toBe("https://mcp.example.com/token");
    expect(res.body.registration_endpoint).toBe("https://mcp.example.com/register");
    expect(res.body.revocation_endpoint).toBe("https://mcp.example.com/revoke");
    expect(res.body.code_challenge_methods_supported).toContain("S256");
  });

  it("serves protected-resource metadata pointing at the MCP endpoint", async () => {
    const { app } = buildApp();
    const res = await request(app).get(
      "/.well-known/oauth-protected-resource/mcp"
    );
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe("https://mcp.example.com/mcp");
    expect(
      res.body.authorization_servers.map((s: string) => s.replace(/\/$/, ""))
    ).toContain("https://mcp.example.com");
    expect(res.body.scopes_supported).toContain("sheets");
  });

  it("/health returns 200", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
