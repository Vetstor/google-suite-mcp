# google-mcp (Google Workspace MCP)

Google Workspace MCP server with 48 tools for reading, writing, searching and managing **Sheets, Docs, Slides, Forms and Apps Script**. Two deployment modes:

- **Remote / OAuth (multi-user)** — deploy to Cloud Run, add as a claude.ai custom connector. Each user logs in with their own Google account and the server acts on Sheets/Docs/Slides/Forms/Apps Script/Drive **as that user**, with that user's own permissions. Built for org rollout to many users.
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

0. **Enable APIs** (APIs & Services → Library): `sheets.googleapis.com`, `drive.googleapis.com`, `docs.googleapis.com`, `slides.googleapis.com`, `forms.googleapis.com`, `script.googleapis.com`. (The deploy script also enables these.)
1. **OAuth consent screen** (APIs & Services → OAuth consent screen): set **User type = Internal** (org-only), add the scopes
   `openid`, `email`, `.../auth/spreadsheets`, `.../auth/drive`, `.../auth/documents`, `.../auth/presentations`, `.../auth/forms.body`, `.../auth/forms.responses.readonly`, `.../auth/script.projects`, `.../auth/script.deployments`.
2. **OAuth client** (Credentials → Create credentials → OAuth client ID → **Web application**). After the first deploy you'll get the service URL; add the **Authorized redirect URI**:
   `https://<service-url>/oauth/google/callback`
3. Note the client id + secret for the deploy step.

> **Re-consent after scope changes** — when the requested Google scopes change, the server bumps `SCOPE_VERSION` (in `src/remote/config.ts`). Already-connected users are then forced to re-run the Google login the next time they call the server (existing access tokens 401, refresh grants fail with `invalid_grant`) so they grant the new permissions. No action needed beyond reconnecting in claude.ai.

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

1. Enable the [Sheets](https://console.cloud.google.com/apis/library/sheets.googleapis.com), [Drive](https://console.cloud.google.com/apis/library/drive.googleapis.com), [Docs](https://console.cloud.google.com/apis/library/docs.googleapis.com), [Slides](https://console.cloud.google.com/apis/library/slides.googleapis.com), [Forms](https://console.cloud.google.com/apis/library/forms.googleapis.com) and [Apps Script](https://console.cloud.google.com/apis/library/script.googleapis.com) APIs.
2. Create a [service account](https://console.cloud.google.com/iam-admin/serviceaccounts) and download the JSON key.

### 2. Share spreadsheets

Share each spreadsheet (or the Drive folder) with the service account email (`…@….iam.gserviceaccount.com`).

### 3. (Optional) Domain-wide delegation (Google Workspace)

To act as any user in your domain: [Workspace Admin → Security → API controls → Domain-wide delegation](https://admin.google.com/ac/owl/domainwidedelegation), add the SA client ID with the `spreadsheets`, `drive`, `documents`, `presentations`, `forms.body`, `forms.responses.readonly`, `script.projects` + `script.deployments` scopes, and set `GOOGLE_IMPERSONATE_USER=user@yourdomain.com`.

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

### Sheets

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

### Docs

| Tool | Description |
|------|-------------|
| `list_documents` | List Google Docs accessible to the caller; filter by name or folder |
| `get_document` | Get a doc as plain text (headings → `#`, bullets → `- `, tables → ` \| `); optional raw JSON |
| `create_document` | Create a new doc, optionally in a folder and with initial text |
| `append_text` | Append text to the end of the body; optional heading style |
| `insert_text` | Insert text at an explicit 1-based body index (index 1 = start) |
| `replace_text` | Replace all occurrences of a string; returns occurrencesChanged |
| `batch_update_docs_raw` | Advanced: send raw Docs API Request objects |

### Slides

| Tool | Description |
|------|-------------|
| `list_presentations` | List presentations accessible to the caller; filter by name or folder |
| `get_presentation` | Get structure: slides, elements, text, notes, placeholder types; optional raw JSON |
| `create_presentation` | Create a new presentation, optionally in a folder |
| `add_slide` | Add a slide by predefined layout; optionally fill title/body placeholders |
| `replace_text_in_presentation` | Replace all occurrences across the deck (or specific slides) |
| `insert_text_box` | Add a text box with text (EMU position/size; 1 in = 914400 EMU) |
| `insert_image` | Insert an image from a public URL (EMU position/size) |
| `delete_slide` | Delete a slide/object by object id |
| `get_slide_thumbnail` | Get a temporary PNG thumbnail URL for a slide |
| `batch_update_slides_raw` | Advanced: send raw Slides API Request objects |

### Forms

| Tool | Description |
|------|-------------|
| `list_forms` | List Google Forms accessible to the caller; filter by name or folder |
| `get_form` | Get structure: title, description, responderUri, linkedSheetId, items (type/required/options); optional raw JSON |
| `create_form` | Create a new form (title/documentTitle); description applied via batchUpdate; optional folder |
| `add_question` | High-level: add SHORT_TEXT/PARAGRAPH/MULTIPLE_CHOICE/CHECKBOXES/DROPDOWN/LINEAR_SCALE/DATE/TIME; appends by default |
| `update_form_info` | Update the form's title and/or description |
| `delete_item` | Delete an item by itemId (index resolved via forms.get) |
| `list_responses` | List responses flattened to `{responseId, createTime, respondentEmail?, answers:{[title]: value\|value[]}}`; optional filter/paging |
| `batch_update_forms_raw` | Advanced: send raw Forms API Request objects |

### Apps Script

| Tool | Description |
|------|-------------|
| `list_script_projects` | List Apps Script projects accessible to the caller; filter by name or folder |
| `create_script_project` | Create a project; pass `parentId` (Sheet/Doc/Form/Slides id) for a container-bound script |
| `get_script_project` | Get metadata + files `[{name, type (SERVER_JS\|JSON\|HTML), source}]` |
| `update_script_content` | Write files; merges by name and preserves the `appsscript` manifest (or `replaceAll`) |
| `list_script_versions` | List saved versions |
| `create_script_version` | Create an immutable version snapshot |
| `list_script_deployments` | List deployments |
| `create_script_deployment` | Deploy a version (`versionNumber`, optional `manifestFileName`) |
| `run_script_function` | Execute a function via `scripts.run` (see caveats below) |
| `get_script_processes` | List recent executions with function/type/status/timing |

> **Apps Script caveats**
> - **`run_script_function` is constrained.** `scripts.run` only works when the script's associated **GCP project is the same as this server's OAuth client project** *and* the script has an **"API Executable" deployment**. Most user-owned scripts won't qualify and will return 403/404. Creating, reading and updating project source works for any script the user owns.
> - **Per-user Apps Script API switch.** Each user must turn on the Apps Script API once at [script.google.com/home/usersettings](https://script.google.com/home/usersettings) before the script tools work for them.
