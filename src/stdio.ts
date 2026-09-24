#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Validate auth eagerly so we fail with a clear message instead of a crash
import {
  loadServiceAccountKey,
  getServiceAccountEmail,
  getSheetsClient,
  getDriveClient,
  getDocsClient,
  getSlidesClient,
} from "./auth.js";
import { setServiceAccountEmailHint, type GetClients } from "./helpers.js";
import { registerAllTools } from "./tools/index.js";

function validateAuth(): void {
  try {
    loadServiceAccountKey();
  } catch (err) {
    process.stderr.write(`\nFatal: ${(err as Error).message}\n\n`);
    process.stderr.write(
      "Set one of:\n" +
        "  GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/service-account.json\n" +
        "  GOOGLE_SERVICE_ACCOUNT_KEY='{...}' (raw JSON or base64)\n\n" +
        "Optional:\n" +
        "  GOOGLE_IMPERSONATE_USER=user@yourdomain.com  (domain-wide delegation)\n\n"
    );
    process.exit(1);
  }
}

validateAuth();

// In stdio mode the caller is the service account, so surface the
// "share the sheet with <sa-email>" hint on 403/404 errors.
setServiceAccountEmailHint(getServiceAccountEmail);

const server = new McpServer({
  name: "google-workspace-mcp",
  version: "1.0.0",
});

// A single shared service-account identity for every call.
const getClients: GetClients = async () => ({
  sheets: getSheetsClient(),
  drive: getDriveClient(),
  docs: getDocsClient(),
  slides: getSlidesClient(),
});

registerAllTools(server, getClients);

const transport = new StdioServerTransport();
await server.connect(transport);
