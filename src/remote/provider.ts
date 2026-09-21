import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Config } from "./config.js";
import { MCP_SCOPES } from "./config.js";
import type { Store } from "./store.js";
import { buildGoogleAuthUrl } from "./google.js";
import { invalidateUserClients } from "./google.js";
import { randomToken, sha256 } from "./crypto.js";
import type { Logger } from "./logger.js";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(private store: Store) {}

  getClient(clientId: string) {
    return this.store.getClient(clientId);
  }

  async registerClient(client: OAuthClientInformationFull) {
    await this.store.createClient(client);
    return client;
  }
}

export class SheetsOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private config: Config,
    private store: Store,
    private logger: Logger
  ) {
    this.clientsStore = new ClientsStore(store);
  }

  /** Persist a pending auth and redirect the user to Google's consent screen. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const id = randomToken(24);
    await this.store.createPendingAuth({
      id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? MCP_SCOPES,
      resource: params.resource?.href,
      expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
    });
    res.redirect(302, buildGoogleAuthUrl(this.config, id));
  }

  /** Return the PKCE challenge recorded for one of our authorization codes. */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const rec = await this.store.getAuthCode(sha256(authorizationCode));
    if (!rec) throw new InvalidGrantError("Invalid or expired authorization code.");
    return rec.codeChallenge;
  }

  /** Single-use exchange of our auth code for an access + refresh token pair. */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const codeHash = sha256(authorizationCode);
    const rec = await this.store.getAuthCode(codeHash);
    if (!rec) throw new InvalidGrantError("Invalid or expired authorization code.");
    // Single-use: delete immediately so a replay fails.
    await this.store.deleteAuthCode(codeHash);
    if (rec.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code was issued to a different client.");
    }
    return this.issueTokens(rec.sub, client.client_id, rec.scopes, rec.resource);
  }

  /** Rotating refresh: the presented refresh token is consumed and replaced. */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    const rec = await this.store.takeRefreshToken(sha256(refreshToken));
    if (!rec) throw new InvalidGrantError("Invalid or expired refresh token.");
    if (rec.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token was issued to a different client.");
    }
    // Never widen scope on refresh.
    const nextScopes =
      scopes && scopes.length > 0
        ? scopes.filter((s) => rec.scopes.includes(s))
        : rec.scopes;
    return this.issueTokens(rec.sub, client.client_id, nextScopes, rec.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = await this.store.getAccessToken(sha256(token));
    if (!rec) throw new InvalidTokenError("Access token is invalid or expired.");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: rec.resource ? new URL(rec.resource) : undefined,
      extra: { sub: rec.sub },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const hash = sha256(request.token);
    // We don't know which kind it is; clear both. Invalidate the user's cache
    // if we can identify them from an access token record.
    const access = await this.store.getAccessToken(hash);
    if (access) invalidateUserClients(access.sub);
    await Promise.all([
      this.store.deleteAccessToken(hash),
      this.store.deleteRefreshToken(hash),
    ]);
  }

  private async issueTokens(
    sub: string,
    clientId: string,
    scopes: string[],
    resource?: string
  ): Promise<OAuthTokens> {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const now = Date.now();

    await this.store.createAccessToken({
      tokenHash: sha256(accessToken),
      sub,
      clientId,
      scopes,
      resource,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
    });
    await this.store.createRefreshToken({
      tokenHash: sha256(refreshToken),
      sub,
      clientId,
      scopes,
      resource,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}
