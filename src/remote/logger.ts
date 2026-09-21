import pino from "pino";

/**
 * Structured JSON logger. NEVER pass tokens, authorization codes, refresh
 * tokens, or client secrets to this — log identifiers (sub, email, clientId)
 * and event names only.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["code", "token", "access_token", "refresh_token", "client_secret"],
    censor: "[redacted]",
  },
});

export type Logger = pino.Logger;
