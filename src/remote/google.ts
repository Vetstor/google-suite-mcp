import { google } from "googleapis";
import type { Config } from "./config.js";
import { GOOGLE_SCOPES } from "./config.js";
import { decrypt } from "./crypto.js";
import type { GoogleClients } from "../helpers.js";
import type { Store } from "./store.js";

type OAuth2 = InstanceType<typeof google.auth.OAuth2>;

// Use googleapis' bundled OAuth2 client so its type matches google.sheets/drive.
function baseClient(config: Config): OAuth2 {
  return new google.auth.OAuth2({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
  });
}

/**
 * Build the Google consent URL the user is redirected to. `state` carries our
 * pending-auth id so the callback can correlate the response.
 */
export function buildGoogleAuthUrl(config: Config, state: string): string {
  const client = baseClient(config);
  const opts: Parameters<OAuth2["generateAuthUrl"]>[0] = {
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state,
  };
  // Hint the primary allowed domain so the account picker prefers it.
  if (config.allowedDomains.length > 0) {
    opts.hd = config.allowedDomains[0];
  }
  return client.generateAuthUrl(opts);
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  hd?: string;
  refreshToken?: string;
  /** Space-delimited scopes Google actually granted (token response `scope`). */
  grantedScopes?: string;
}

/**
 * Exchange the Google authorization code, verify the id_token, and return the
 * verified identity plus any refresh token Google issued.
 */
export async function exchangeGoogleCode(
  config: Config,
  code: string
): Promise<GoogleIdentity> {
  const client = baseClient(config);
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw new Error("Google did not return an id_token.");
  }
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.googleClientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google id_token missing sub or email.");
  }
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    hd: payload.hd,
    refreshToken: tokens.refresh_token ?? undefined,
    grantedScopes: tokens.scope ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Per-user Google client cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  clients: GoogleClients;
  expiresAt: number;
}

const CACHE_TTL_MS = 50 * 60 * 1000; // refresh well before Google's 1h access token
const cache = new Map<string, CacheEntry>();

/**
 * Resolve Sheets/Drive clients acting as the given user. The underlying
 * OAuth2 client holds the user's refresh token and auto-refreshes access
 * tokens. Instances are cached per `sub` for ~50 minutes.
 */
export async function getUserClients(
  config: Config,
  store: Store,
  sub: string
): Promise<GoogleClients> {
  const hit = cache.get(sub);
  if (hit && hit.expiresAt > Date.now()) return hit.clients;

  const user = await store.getUser(sub);
  if (!user) throw new Error(`No stored credentials for user ${sub}.`);

  const refreshToken = decrypt(user.refreshTokenEnc, config.tokenEncryptionKey);
  const auth = new google.auth.OAuth2({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  });
  auth.setCredentials({ refresh_token: refreshToken });

  const clients: GoogleClients = {
    sheets: google.sheets({ version: "v4", auth }),
    drive: google.drive({ version: "v3", auth }),
    docs: google.docs({ version: "v1", auth }),
    slides: google.slides({ version: "v1", auth }),
  };
  cache.set(sub, { clients, expiresAt: Date.now() + CACHE_TTL_MS });
  return clients;
}

/** Drop a user's cached clients (e.g. after revocation). */
export function invalidateUserClients(sub: string): void {
  cache.delete(sub);
}
