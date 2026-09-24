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
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Config } from "./config.js";
import { MCP_SCOPES, SCOPE_VERSION } from "./config.js";
import type { Store } from "./store.js";
import { buildGoogleAuthUrl } from "./google.js";
import { invalidateUserClients } from "./google.js";
import { randomToken, sha256 } from "./crypto.js";
import type { Logger } from "./logger.js";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private store: Store,
    private logger: Logger
  ) {}

  async getClient(clientId: string) {
    try {
      return await this.store.getClient(clientId);
    } catch (err) {
      this.logger.error({ event: "clientsStore.getClient_error", clientId, err: (err as Error).message, stack: (err as Error).stack }, "getClient failed");
      throw err;
    }
  }

  async registerClient(client: OAuthClientInformationFull) {
    try {
      await this.store.createClient(client);
    } catch (err) {
      this.logger.error({ event: "clientsStore.registerClient_error", clientId: client.client_id, err: (err as Error).message, stack: (err as Error).stack }, "registerClient failed");
      throw err;
    }
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
    this.clientsStore = new ClientsStore(store, logger);
  }

  private allowedResource(resource: string | undefined): string {
    const allowed = [
      this.config.mcpResourceUrl,
      `${this.config.baseUrl}/mcp/write`,
      `${this.config.baseUrl}/mcp/read`,
    ];
    if (!resource || !allowed.includes(resource)) {
      throw new InvalidTargetError("Specify one of this server's MCP resource URLs.");
    }
    return resource;
  }

  /** Small helper: log any thrown error under the given method name, then rethrow. */
  private async logged<T>(method: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.logger.error(
        { event: `provider.${method}_error`, err: (err as Error).message, stack: (err as Error).stack },
        `${method} threw`
      );
      throw err;
    }
  }

  /** Persist a pending auth and redirect the user to Google's consent screen. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const resource = this.allowedResource(params.resource?.href);
    const id = randomToken(24);
    await this.store.createPendingAuth({
      id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : MCP_SCOPES,
      resource,
      expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
    });
    res.redirect(302, buildGoogleAuthUrl(this.config, id));
  }

  /** Return the PKCE challenge recorded for one of our authorization codes. */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    return this.logged("challengeForAuthorizationCode", async () => {
      const rec = await this.store.getAuthCode(sha256(authorizationCode));
      if (!rec) throw new InvalidGrantError("Invalid or expired authorization code.");
      return rec.codeChallenge;
    });
  }

  /** Single-use exchange of our auth code for an access + refresh token pair. */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    return this.logged("exchangeAuthorizationCode", async () => {
      const codeHash = sha256(authorizationCode);
      const rec = await this.store.takeAuthCode(codeHash);
      if (!rec) throw new InvalidGrantError("Invalid or expired authorization code.");
      if (rec.clientId !== client.client_id) {
        throw new InvalidGrantError("Authorization code was issued to a different client.");
      }
      if ((redirectUri && redirectUri !== rec.redirectUri) ||
          (resource && resource.href !== rec.resource)) {
        throw new InvalidGrantError("Authorization code parameters do not match the original request.");
      }
      return this.issueTokens(rec.sub, client.client_id, rec.scopes, this.allowedResource(rec.resource));
    });
  }

  /** Rotating refresh: the presented refresh token is consumed and replaced. */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    return this.logged("exchangeRefreshToken", async () => {
      const rec = await this.store.takeRefreshToken(sha256(refreshToken));
      if (!rec) throw new InvalidGrantError("Invalid or expired refresh token.");
      if (rec.clientId !== client.client_id) {
        throw new InvalidGrantError("Refresh token was issued to a different client.");
      }
      if (resource && resource.href !== rec.resource) {
        throw new InvalidGrantError("Refresh token cannot be used for a different resource.");
      }
      // Reject if the user's granted scopes are stale (Google scope set changed
      // since they consented). They must re-run OAuth to grant the new scopes.
      const user = await this.store.getUser(rec.sub);
      if (!user || user.scopeVersion !== SCOPE_VERSION) {
        throw new InvalidGrantError(
          "Authorization scopes have changed; please reconnect to grant the new permissions."
        );
      }
      // Never widen scope on refresh.
      const nextScopes =
        scopes && scopes.length > 0
          ? scopes.filter((s) => rec.scopes.includes(s))
          : rec.scopes;
      return this.issueTokens(rec.sub, client.client_id, nextScopes, this.allowedResource(rec.resource));
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return this.logged("verifyAccessToken", async () => {
      const rec = await this.store.getAccessToken(sha256(token));
      if (!rec) throw new InvalidTokenError("Access token is invalid or expired.");
      // Reject tokens for users whose consented scope set is stale (or who
      // predate scope versioning). Throwing InvalidTokenError yields a 401 with
      // WWW-Authenticate, so the client re-runs OAuth and grants the new scopes.
      const user = await this.store.getUser(rec.sub);
      if (!user || user.scopeVersion !== SCOPE_VERSION) {
        invalidateUserClients(rec.sub);
        throw new InvalidTokenError(
          "Authorization scopes have changed; please reconnect to grant the new permissions."
        );
      }
      return {
        token,
        clientId: rec.clientId,
        scopes: rec.scopes,
        expiresAt: Math.floor(rec.expiresAt / 1000),
        resource: rec.resource ? new URL(rec.resource) : undefined,
        extra: { sub: rec.sub },
      };
    });
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    return this.logged("revokeToken", async () => {
      const hash = sha256(request.token);
      // We don't know which kind it is; clear both. Invalidate the user's cache
      // if we can identify them from an access token record.
      const access = await this.store.getAccessToken(hash);
      if (access) invalidateUserClients(access.sub);
      await Promise.all([
        this.store.deleteAccessToken(hash),
        this.store.deleteRefreshToken(hash),
      ]);
    });
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
