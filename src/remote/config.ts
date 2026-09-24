import { z } from "zod";

/**
 * The Google OAuth scopes we request from the end user. `openid`/`email` let us
 * identify them; the Sheets/Drive scopes let us act on their behalf.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.deployments",
];

/**
 * Bump whenever GOOGLE_SCOPES changes so previously-authorized users are forced
 * to re-consent. A user's stored `scopeVersion` is compared against this on
 * every access-token verification and refresh-token grant; a mismatch (or a
 * missing value, i.e. a pre-versioning user) invalidates their session and
 * triggers a fresh OAuth run.
 */
export const SCOPE_VERSION = "3";

/** The single logical MCP scope advertised to OAuth clients (claude.ai). */
export const MCP_SCOPES = ["sheets"];

const rawSchema = z.object({
  BASE_URL: z
    .string()
    .url()
    .describe("Public https URL of this service, no trailing slash."),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .describe("32-byte key, base64-encoded, for AES-256-GCM."),
  ALLOWED_DOMAINS: z.string().optional(),
  STORE: z.enum(["firestore", "memory"]).default("firestore"),
  FIRESTORE_DATABASE: z.string().default("(default)"),
  PORT: z.coerce.number().int().positive().default(8080),
});

export interface Config {
  baseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  /** 32-byte AES-256 key. */
  tokenEncryptionKey: Buffer;
  /** Lowercased allowed email domains; empty = allow all (with a warning). */
  allowedDomains: string[];
  store: "firestore" | "memory";
  firestoreDatabase: string;
  port: number;
  /** Google's redirect back into us after user consent. */
  googleRedirectUri: string;
  /** The RFC 8707 resource identifier for the MCP endpoint. */
  mcpResourceUrl: string;
}

/**
 * Parse and validate configuration from a source (defaults to process.env).
 * Throws a single clear error listing every problem.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid remote server configuration:\n${issues}\n\n` +
        "Required env vars: BASE_URL, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY."
    );
  }
  const e = parsed.data;

  const key = Buffer.from(e.TOKEN_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
        "Generate one with: openssl rand -base64 32"
    );
  }

  const baseUrl = e.BASE_URL.replace(/\/+$/, "");
  const allowedDomains = (e.ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  return {
    baseUrl,
    googleClientId: e.GOOGLE_OAUTH_CLIENT_ID,
    googleClientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET,
    tokenEncryptionKey: key,
    allowedDomains,
    store: e.STORE,
    firestoreDatabase: e.FIRESTORE_DATABASE,
    port: e.PORT,
    googleRedirectUri: `${baseUrl}/oauth/google/callback`,
    mcpResourceUrl: `${baseUrl}/mcp`,
  };
}
