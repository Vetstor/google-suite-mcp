import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetClients, RegisterCtx } from "../helpers.js";
import type { Tier } from "./tiers.js";
import { registerDriveTools } from "./drive.js";
import { registerMetadataTools } from "./metadata.js";
import { registerValueTools } from "./values.js";
import { registerAdvancedTools } from "./advanced.js";
import { registerDocsTools } from "./docs.js";
import { registerSlidesTools } from "./slides.js";
import { registerFormsTools } from "./forms.js";
import { registerScriptTools } from "./script.js";

export type { Tier };

/**
 * Register Google Workspace tools on an McpServer.
 *
 * @param opts.tiers - Only register tools in these tiers (default: all three).
 *   Useful to expose read-only or read+write subsets.
 */
export function registerAllTools(
  server: McpServer,
  getClients: GetClients,
  opts?: { tiers?: Tier[] }
): void {
  const allowed = new Set<Tier>(
    opts?.tiers ?? (["read", "write", "destructive"] as Tier[])
  );
  const ctx: RegisterCtx = { server, getClients, tiers: allowed };

  // Sheets
  registerDriveTools(ctx);
  registerMetadataTools(ctx);
  registerValueTools(ctx);
  registerAdvancedTools(ctx);
  // Docs
  registerDocsTools(ctx);
  // Slides
  registerSlidesTools(ctx);
  // Forms
  registerFormsTools(ctx);
  // Apps Script
  registerScriptTools(ctx);
}
