import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Config } from "./config.js";
import { MCP_SCOPES, SCOPE_VERSION } from "./config.js";
import type { Store } from "./store.js";
import { SheetsOAuthProvider } from "./provider.js";
import { exchangeGoogleCode, getUserClients } from "./google.js";
import { encrypt, randomToken, sha256 } from "./crypto.js";
import { logger as defaultLogger, type Logger } from "./logger.js";
import { registerAllTools } from "../tools/index.js";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

const CORS_ORIGINS = ["https://claude.ai", "https://claude.com"];

export interface AppDeps {
  config: Config;
  store: Store;
  logger?: Logger;
}

export function createApp(deps: AppDeps): express.Express {
  const { config, store } = deps;
  const logger = deps.logger ?? defaultLogger;
  const provider = new SheetsOAuthProvider(config, store, logger);

  const app = express();
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow no-origin (curl / server-to-server) and the claude.ai family.
        if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
    })
  );

  app.use(express.json({ limit: "4mb" }));

  // OAuth 2.1 authorization server + protected-resource metadata + DCR.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.baseUrl),
      baseUrl: new URL(config.baseUrl),
      resourceServerUrl: new URL(config.mcpResourceUrl),
      scopesSupported: MCP_SCOPES,
      resourceName: "Google Workspace MCP",
    })
  );

  // -------------------------------------------------------------------------
  // Google OAuth callback (not part of the MCP OAuth surface)
  // -------------------------------------------------------------------------
  app.get("/oauth/google/callback", async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;

    if (error) {
      logger.warn({ event: "google_callback_error", error }, "Google returned an error");
      return res.status(400).type("text/plain").send(`Google authorization failed: ${error}`);
    }
    if (!code || !state) {
      return res.status(400).type("text/plain").send("Missing code or state.");
    }

    const pending = await store.takePendingAuth(state);
    if (!pending) {
      return res
        .status(400)
        .type("text/plain")
        .send("Authorization request expired or not found. Please try connecting again.");
    }

    let identity;
    try {
      identity = await exchangeGoogleCode(config, code);
    } catch (err) {
      logger.error({ event: "google_token_exchange_failed", err: (err as Error).message });
      return res.status(502).type("text/plain").send("Failed to exchange Google authorization code.");
    }

    // Domain restriction.
    const domain = identity.email.split("@")[1] ?? "";
    if (config.allowedDomains.length === 0) {
      logger.warn(
        { event: "domain_unrestricted", sub: identity.sub, email: identity.email },
        "ALLOWED_DOMAINS is unset — accepting all Google accounts"
      );
    } else if (!config.allowedDomains.includes(domain)) {
      logger.warn(
        { event: "domain_denied", email: identity.email, domain },
        "Rejected login from disallowed domain"
      );
      return res
        .status(403)
        .type("text/plain")
        .send(`Access denied: ${identity.email} is not in an allowed domain.`);
    }

    // Persist / refresh the user's encrypted Google refresh token. Always stamp
    // the current SCOPE_VERSION + granted scopes so re-consent clears a stale
    // version. (prompt=consent normally returns a fresh refresh token; the else
    // branch re-stamps an existing user when Google omits one.)
    if (identity.refreshToken) {
      await store.upsertUser({
        sub: identity.sub,
        email: identity.email,
        refreshTokenEnc: encrypt(identity.refreshToken, config.tokenEncryptionKey),
        updatedAt: Date.now(),
        scopeVersion: SCOPE_VERSION,
        grantedScopes: identity.grantedScopes,
      });
    } else {
      const existing = await store.getUser(identity.sub);
      if (!existing) {
        logger.error({ event: "no_refresh_token", sub: identity.sub });
        return res
          .status(400)
          .type("text/plain")
          .send(
            "Google did not return a refresh token. Remove this app's access at " +
              "https://myaccount.google.com/permissions and try again."
          );
      }
      await store.upsertUser({
        sub: existing.sub,
        email: identity.email,
        refreshTokenEnc: existing.refreshTokenEnc,
        updatedAt: Date.now(),
        scopeVersion: SCOPE_VERSION,
        grantedScopes: identity.grantedScopes,
      });
    }

    logger.info(
      { event: "login", sub: identity.sub, email: identity.email, clientId: pending.clientId },
      "User authenticated"
    );

    // Mint our authorization code bound to this user + the client's PKCE challenge.
    const authCode = randomToken(32);
    await store.createAuthCode({
      codeHash: sha256(authCode),
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      sub: identity.sub,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("code", authCode);
    if (pending.state) redirect.searchParams.set("state", pending.state);
    return res.redirect(302, redirect.href);
  });

  // -------------------------------------------------------------------------
  // MCP endpoint — stateless, one server+transport per request, bound to user
  // -------------------------------------------------------------------------
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    new URL(config.mcpResourceUrl)
  );
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl,
  });

  const mcpHandler = async (req: Request, res: Response) => {
    const sub = req.auth?.extra?.sub as string | undefined;
    if (!sub) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }

    const server = new McpServer({ name: "google-workspace-mcp", version: "1.0.0" });
    registerAllTools(server, () => getUserClients(config, store, sub));

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ event: "mcp_request_failed", err: (err as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", bearer, mcpHandler);
  app.get("/mcp", bearer, mcpHandler);
  app.delete("/mcp", bearer, mcpHandler);

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------
  // /health (Cloud Run's own frontend hijacks /healthz)
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res
      .status(200)
      .type("text/plain")
      .send(
        "Google Workspace MCP server (remote, OAuth 2.1) — Sheets, Docs & Slides.\n" +
          `MCP endpoint: ${config.mcpResourceUrl}\n` +
          "Add as a custom connector in claude.ai. See README for setup.\n"
      );
  });

  // ---------------------------------------------------------------------------
  // Global error handler — must be last, after all routes.
  // Logs the error (message + stack only; never req body/headers) via pino and
  // returns a 500 JSON so the SDK's "server_error" response is at least logged.
  // ---------------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error({ event: "unhandled_error", err: message, stack }, "Unhandled Express error");
    if (!res.headersSent) {
      res.status(500).json({ error: "server_error", error_description: "Internal Server Error" });
    }
  });

  return app;
}
