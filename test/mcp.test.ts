import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "./helpers.js";
import { sha256 } from "../src/remote/crypto.js";

const EXPECTED_TOOLS = [
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

  it("lists the 13 tools with a valid bearer token", async () => {
    const { app, store } = buildApp();
    const token = "valid-access-token";
    await store.createAccessToken({
      tokenHash: sha256(token),
      sub: "sub-1",
      clientId: "client-1",
      scopes: ["sheets"],
      resource: "https://mcp.example.com/mcp",
      expiresAt: Date.now() + 3600_000,
    });

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
    expect(names).toHaveLength(13);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });
});
