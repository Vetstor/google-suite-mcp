import type { GaxiosError } from "googleapis-common";
import type {
  sheets_v4,
  drive_v3,
  docs_v1,
  slides_v1,
  forms_v1,
  script_v1,
} from "googleapis";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_TIERS, type Tier } from "./tools/tiers.js";

/** The Google API clients a tool needs, bound to a specific identity. */
export interface GoogleClients {
  sheets: sheets_v4.Sheets;
  drive: drive_v3.Drive;
  docs: docs_v1.Docs;
  slides: slides_v1.Slides;
  forms: forms_v1.Forms;
  script: script_v1.Script;
}

/** Lazily resolves the Google clients for the current caller (SA or per-user OAuth). */
export type GetClients = () => Promise<GoogleClients>;

/**
 * Optional hook that returns a service-account email for error hints.
 * The stdio entrypoint sets this; the remote (OAuth) entrypoint leaves it unset
 * so the share-with-service-account hint is suppressed.
 */
let serviceAccountEmailHint: (() => string) | undefined;
export function setServiceAccountEmailHint(fn: () => string): void {
  serviceAccountEmailHint = fn;
}

/**
 * Extract spreadsheet ID from either a bare ID or a full Google Sheets URL.
 * Handles: https://docs.google.com/spreadsheets/d/<id>/edit...
 */
export function parseSpreadsheetId(idOrUrl: string): string {
  const match = idOrUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Assume it's already a bare ID
  return idOrUrl.trim();
}

/**
 * Extract a Drive file ID from a bare ID or any Google file URL that uses the
 * `/d/<id>/…` shape (Docs, Slides, Sheets). Falls back to the trimmed input.
 */
export function parseDriveId(idOrUrl: string): string {
  const match = idOrUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return idOrUrl.trim();
}

/**
 * Convert a Google API error to a user-friendly MCP tool response.
 */
export function handleGoogleError(
  err: unknown,
  context = "Google API error"
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const e = err as GaxiosError;
  const status = e?.response?.status ?? e?.status;
  const message =
    (e?.response?.data as { error?: { message?: string } })?.error?.message ??
    e?.message ??
    String(err);

  let hint = "";
  if ((status === 403 || status === 404) && serviceAccountEmailHint) {
    try {
      const saEmail = serviceAccountEmailHint();
      hint = `\nHint: Share the spreadsheet/folder with the service account: ${saEmail}`;
    } catch {
      // ignore — we're already in error handling
    }
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${context}: ${message}${hint}`,
      },
    ],
  };
}

/** Successful JSON response */
export function jsonResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Tool registration context + defineTool helper
// ---------------------------------------------------------------------------

/**
 * Context passed to every tool-registration function.
 * Replaces the old (server, getClients) pair and adds tier filtering.
 */
export interface RegisterCtx {
  server: McpServer;
  getClients: GetClients;
  /** Allowed tier set — tools outside this set are silently skipped. */
  tiers: Set<Tier>;
}

const TIER_ANNOTATIONS: Record<Tier, ToolAnnotations> = {
  read: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  write: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  destructive: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
};

/** Convert a snake_case tool name to a Title Case human label. */
function toTitle(name: string): string {
  return name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Register one tool on the server with automatic tier filtering and MCP
 * annotations. Throws at startup if the tool name is missing from TOOL_TIERS.
 * Call this instead of server.tool() / server.registerTool() in every tool file.
 */
export function defineTool<T extends Record<string, z.ZodTypeAny>>(
  ctx: RegisterCtx,
  name: string,
  config: { title?: string; description: string; inputSchema: T },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: { [K in keyof T]: z.infer<T[K]> }) => Promise<any>
): void {
  const tier = TOOL_TIERS[name];
  if (tier === undefined) {
    throw new Error(`[defineTool] Tool "${name}" has no entry in TOOL_TIERS.`);
  }
  if (!ctx.tiers.has(tier)) return; // tier not in allowed set — skip

  const annotations: ToolAnnotations = TIER_ANNOTATIONS[tier];

  // Use the 5-arg deprecated overload (name, desc, schema, annotations, cb)
  // because it preserves per-call type inference for the schema shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  (ctx.server.tool as any)(
    name,
    config.description,
    config.inputSchema,
    { ...annotations, title: config.title ?? toTitle(name) },
    handler
  );
}
