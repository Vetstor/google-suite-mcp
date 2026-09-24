import type { GaxiosError } from "googleapis-common";
import type {
  sheets_v4,
  drive_v3,
  docs_v1,
  slides_v1,
  forms_v1,
  script_v1,
} from "googleapis";

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
