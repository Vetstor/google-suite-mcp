import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetClients } from "../helpers.js";
import { registerDriveTools } from "./drive.js";
import { registerMetadataTools } from "./metadata.js";
import { registerValueTools } from "./values.js";
import { registerAdvancedTools } from "./advanced.js";
import { registerDocsTools } from "./docs.js";
import { registerSlidesTools } from "./slides.js";
import { registerFormsTools } from "./forms.js";
import { registerScriptTools } from "./script.js";

/**
 * Register all Google Workspace tools (Sheets + Docs + Slides) on an McpServer,
 * bound to the given client resolver. Both the stdio (service-account) and
 * remote (per-user OAuth) entrypoints call this so the tool surface stays
 * identical.
 */
export function registerAllTools(server: McpServer, getClients: GetClients) {
  // Sheets
  registerDriveTools(server, getClients);
  registerMetadataTools(server, getClients);
  registerValueTools(server, getClients);
  registerAdvancedTools(server, getClients);
  // Docs
  registerDocsTools(server, getClients);
  // Slides
  registerSlidesTools(server, getClients);
  // Forms
  registerFormsTools(server, getClients);
  // Apps Script
  registerScriptTools(server, getClients);
}
