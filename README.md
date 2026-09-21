# sheets-mcp

Google Sheets MCP server with 13 tools for reading, writing, searching and managing spreadsheets. Two deployment modes:

- **Remote / OAuth (multi-user)** — deploy to Cloud Run, add as a claude.ai custom connector. Each user logs in with their own Google account and the server acts on Sheets/Drive **as that user**, with that user's own permissions. Built for org rollout to many users.
- **Stdio / service account (headless)** — a single service-account identity over stdio, for Claude Desktop / Claude Code / cron jobs.

---

## Remote mode (OAuth 2.1, multi-user)

### Architecture (in 6 lines)

1. This server is its own OAuth 2.1 Authorization Server and brokers to Google (proxy pattern).
2. claude.ai discovers `/.well-known/oauth-protected-resource/mcp` + `/.well-known/oauth-authorization-server`, registers via DCR (`/register`), and sends the user to `/authorize` (PKCE).
3. `/authorize` stores a pending record and redirects the user to Google consent (`access_type=offline`, `prompt=consent`).
4. `/oauth/google/callback` verifies the Google id_token, **enforces the email domain allowlist**, stores the user's Google refresh token **encrypted (AES-256-GCM)**, and returns our own auth code to claude.ai.
5. `/token` (SDK-handled PKCE) issues an opaque access token (1h) + rotating refresh token (30d); only SHA-256 hashes are persisted.
6. `/mcp` is a **stateless** Streamable HTTP endpoint behind `requireBearerAuth`; each request builds a per-user Google client (auto-refreshing, cached ~50 min) and runs the tools as that user.

State lives in **Firestore**; the `expiresAt` field is a Timestamp so a TTL policy can auto-expire codes/tokens.

### One-time GCP + OAuth setup

1. **OAuth consent screen** (APIs & Services → OAuth consent screen): set **User type = Internal** (org-only), add the scopes
   `openid`, `email`, `.../auth/spreadsheets`, `.../auth/drive`.
2. **OAuth client** (Credentials → Create credentials → OAuth client ID → **Web application**). After the first deploy you'll get the service URL; add the **Authorized redirect URI**:
   `https://<service-url>/oauth/google/callback`
3. Note the client id + secret for the deploy step.

### Deploy (Cloud Run)

```bash
export PROJECT_ID=your-gcp-project
export GOOGLE_OAUTH_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
export GOOGLE_OAUTH_CLIENT_SECRET=your-oauth-client-secret
export ALLOWED_DOMAINS=vetstor.cz          # comma-separated; omit to allow all
bash deploy/deploy.sh
```

The script enables the required APIs, creates the Firestore native DB (`europe-west1`), creates the secrets `sheets-mcp-google-client-secret` and `sheets-mcp-token-key` (32-byte key via `openssl`), grants the Cloud Run service account `secretmanager.secretAccessor` + `datastore.user`, deploys, and prints the service URL. On the first run it deploys once to reserve the URL, then sets `BASE_URL` to it. **After the first deploy, add the redirect URI (step 2 above) and re-run if needed.**

### Add to claude.ai

Settings → **Connectors** → **Add custom connector** → URL:

```
https://<service-url>/mcp
```

No client id/secret to paste — dynamic client registration handles it. You'll be sent to Google to log in; only accounts in `ALLOWED_DOMAINS` are accepted.

### Security notes

- **Domain restriction** — logins outside `ALLOWED_DOMAINS` get 403 and no data is stored. If unset, all Google accounts are accepted (logged as a warning).
- **Encrypted refresh tokens** — each user's Google refresh token is AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` before hitting Firestore.
- **Hashed tokens** — our access/refresh codes and tokens are stored only as SHA-256 hashes; auth codes are single-use and refresh tokens rotate on every use.
- **Revocation** — `/revoke` (RFC 7009) is supported and drops the user's cached Google client.
- Tokens/codes/secrets are never logged (pino redaction); logins log only `email` + `sub`.

---

## Stdio mode (service account)

### 1. GCP Console

1. Enable [Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com) and [Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
2. Create a [service account](https://console.cloud.google.com/iam-admin/serviceaccounts) and download the JSON key.

### 2. Share spreadsheets

Share each spreadsheet (or the Drive folder) with the service account email (`…@….iam.gserviceaccount.com`).

### 3. (Optional) Domain-wide delegation (Google Workspace)

To act as any user in your domain: [Workspace Admin → Security → API controls → Domain-wide delegation](https://admin.google.com/ac/owl/domainwidedelegation), add the SA client ID with the `spreadsheets` + `drive` scopes, and set `GOOGLE_IMPERSONATE_USER=user@yourdomain.com`.

### 4. Config

Copy `.env.example` to `.env` and fill in the key path. Then in **Claude Desktop** / **Claude Code**:

```json
{
  "mcpServers": {
    "sheets": {
      "command": "node",
      "args": ["/absolute/path/to/sheets-mcp/dist/stdio.js"],
      "env": {
        "GOOGLE_SERVICE_ACCOUNT_KEY_FILE": "/path/to/service-account.json"
      }
    }
  }
}
```

### 5. Build & run

```bash
npm install
npm run build
npm run start:stdio     # or: npm run dev:stdio
```

---

## Development

```bash
npm install
npm run build           # strict TypeScript -> dist/
npm test                # vitest (MemoryStore + supertest, Google mocked)
npm run dev             # remote server via tsx (needs remote env vars)
npm run dev:stdio       # stdio server via tsx (needs service-account env)
```

Layout: `src/tools/*` (shared tool implementations), `src/stdio.ts` (SA entry), `src/remote/*` (express app, OAuth provider, Firestore/Memory store, Google helpers, crypto, config), `test/*` (vitest).

---

## Tools

| Tool | Description |
|------|-------------|
| `list_spreadsheets` | List spreadsheets accessible to the caller; filter by name or folder |
| `get_spreadsheet` | Get metadata: title, sheets, named ranges |
| `read_range` | Read cell values (A1 notation); optionally return as objects |
| `batch_read` | Read multiple ranges in one call |
| `write_range` | Write a 2D array of values to a range |
| `batch_write` | Write to multiple ranges in one call |
| `append_rows` | Append rows after existing data |
| `clear_range` | Clear values in a range (keeps formatting) |
| `find_cells` | Client-side search; returns cell addresses + values (max 200) |
| `create_spreadsheet` | Create a new spreadsheet, optionally in a folder |
| `add_sheet` | Add a sheet tab |
| `delete_sheet` | Delete a sheet tab by ID or title |
| `batch_update_raw` | Advanced: send raw Sheets API Request objects (formatting, merges, etc.) |
