import { vi } from "vitest";
import request from "supertest";
import pino from "pino";
import { google } from "googleapis";
import { generateChallenge } from "pkce-challenge";
import { loadConfig, type Config } from "../src/remote/config.js";
import { MemoryStore } from "../src/remote/store.js";
import { createApp } from "../src/remote/server.js";

export const CLIENT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const silentLogger = pino({ level: "silent" }) as unknown as pino.Logger;

export function testEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    BASE_URL: "https://mcp.example.com",
    GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_DOMAINS: "example.com",
    STORE: "memory",
    ...overrides,
  };
}

export function buildApp(envOverrides: Record<string, string | undefined> = {}) {
  const config: Config = loadConfig(testEnv(envOverrides));
  const store = new MemoryStore();
  const app = createApp({ config, store, logger: silentLogger });
  return { app, store, config };
}

/** Mock Google's token exchange + id_token verification for one callback. */
export function mockGoogle(opts: {
  sub: string;
  email: string;
  hd?: string;
  refreshToken?: string | null;
}) {
  vi.spyOn(google.auth.OAuth2.prototype, "getToken").mockResolvedValue({
    tokens: {
      id_token: "fake.id.token",
      access_token: "fake-access",
      refresh_token: opts.refreshToken === null ? undefined : opts.refreshToken ?? "google-refresh-token",
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.spyOn(google.auth.OAuth2.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => ({ sub: opts.sub, email: opts.email, hd: opts.hd }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

export async function registerClient(app: ReturnType<typeof buildApp>["app"]) {
  const res = await request(app)
    .post("/register")
    .send({
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Test Client",
    });
  return res;
}

/** Compute the S256 code_challenge for a verifier. */
export async function challengeFor(verifier: string): Promise<string> {
  return generateChallenge(verifier);
}

/**
 * Drive DCR -> /authorize -> Google callback and return the issued
 * authorization code plus the material needed to redeem it at /token.
 */
export async function authorizeUntilCode(
  ctx: ReturnType<typeof buildApp>,
  opts: { email: string; sub?: string; clientState?: string; resource?: string; omitScope?: boolean }
) {
  const { app } = ctx;
  const reg = await registerClient(app);
  const clientId = reg.body.client_id as string;
  const clientSecret = reg.body.client_secret as string;

  const verifier = "test-verifier-0123456789012345678901234567890123456789";
  const codeChallenge = await challengeFor(verifier);
  const clientState = opts.clientState ?? "client-state-xyz";

  const authRes = await request(app)
    .get("/authorize")
    .query({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: clientState,
      scope: opts.omitScope ? undefined : "sheets",
      resource: opts.resource ?? "https://mcp.example.com/mcp",
    });

  const googleUrl = new URL(authRes.headers.location);
  const pendingId = googleUrl.searchParams.get("state")!;

  mockGoogle({ sub: opts.sub ?? "google-sub-1", email: opts.email });

  const cbRes = await request(app)
    .get("/oauth/google/callback")
    .query({ code: "google-auth-code", state: pendingId });

  return { clientId, clientSecret, verifier, clientState, authRes, cbRes };
}
