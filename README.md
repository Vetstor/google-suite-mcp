# Google Workspace MCP

> Give every employee Claude access to Google Sheets, Docs, Slides, Forms and Apps Script — each under **their own Google identity**, admin-controlled.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-connector-6E56CF.svg)](https://modelcontextprotocol.io)

A remote, multi-user [MCP](https://modelcontextprotocol.io) server you host once for your whole
organization. Users add it as a custom connector in claude.ai; each signs in with their own Google
account (OAuth 2.1 + Dynamic Client Registration + PKCE) and Claude acts **as that user**, with that
user's own Drive permissions. Logins are gated by an email-domain allowlist you control. A second
**stdio / service-account** mode covers headless jobs and local dev.

- **48 tools** across Sheets, Docs, Slides, Forms and Apps Script (+ Drive listing).
- **Per-user identity** — no shared service account, no credential sprawl. Drive activity logs show
  the real person.
- **Admin-controlled** — Internal consent screen, domain allowlist, org-wide connector, instant
  revoke.
- **Cheap** — Cloud Run scales to zero, Firestore free tier; roughly **$0/month** for a small org.

---

## What you get

48 tools. High-level tools cover the common cases; each product also has a raw `batch_update_*_raw`
escape hatch for anything the API supports.

| Group | Count | Highlights |
|-------|:----:|-----------|
| Sheets | 13 | read/write ranges, append, search, formatting via raw batchUpdate |
| Docs | 7 | create, read as text, append/insert/replace, raw batchUpdate |
| Slides | 10 | build decks by layout, text/image placement, notes, thumbnails |
| Forms | 8 | build forms, add questions, read flattened responses |
| Apps Script | 10 | create bound scripts, push code, version, deploy, run |

<details><summary><b>Sheets (13)</b></summary>

| Tool | Description |
|------|-------------|
| `list_spreadsheets` | List spreadsheets; filter by name or folder |
| `get_spreadsheet` | Metadata: title, sheets (+ numeric sheetId), named ranges |
| `read_range` | Read a range (A1); optional `asObjects` |
| `batch_read` | Read multiple ranges in one call |
| `write_range` | Write a 2D array to a range |
| `batch_write` | Write to multiple ranges in one call |
| `append_rows` | Append after existing data |
| `clear_range` | Clear values (keeps formatting) |
| `find_cells` | Client-side search; addresses + values (≤200) |
| `create_spreadsheet` | Create a spreadsheet, optionally in a folder |
| `add_sheet` | Add a tab |
| `delete_sheet` | Delete a tab by id or title |
| `batch_update_raw` | Raw Sheets API requests (format, merge, charts, pivots…) |
</details>

<details><summary><b>Docs (7)</b></summary>

| Tool | Description |
|------|-------------|
| `list_documents` | List Docs; filter by name or folder |
| `get_document` | Doc as plain text (headings→`#`, bullets→`-`, tables→` \| `); optional raw JSON |
| `create_document` | Create a doc, optional folder + initial text |
| `append_text` | Append to body; optional heading style |
| `insert_text` | Insert at a 1-based body index |
| `replace_text` | Replace all occurrences |
| `batch_update_docs_raw` | Raw Docs API requests (styles, tables, images…) |
</details>

<details><summary><b>Slides (10)</b></summary>

| Tool | Description |
|------|-------------|
| `list_presentations` | List decks; filter by name or folder |
| `get_presentation` | Structure: slides, elements, text, notes, placeholders; optional raw |
| `create_presentation` | Create a deck, optional folder |
| `add_slide` | Add a slide by layout; auto-fill title/body |
| `replace_text_in_presentation` | Replace text across the deck (or given slides) |
| `insert_text_box` | Add a text box (EMU position/size) |
| `insert_image` | Insert an image from a public URL |
| `delete_slide` | Delete a slide/object |
| `get_slide_thumbnail` | Temporary PNG thumbnail URL |
| `batch_update_slides_raw` | Raw Slides API requests |
</details>

<details><summary><b>Forms (8)</b></summary>

| Tool | Description |
|------|-------------|
| `list_forms` | List Forms; filter by name or folder |
| `get_form` | Structure: items, types, options, responderUri, linkedSheetId |
| `create_form` | Create a form; optional description + folder |
| `add_question` | Add SHORT_TEXT/PARAGRAPH/MULTIPLE_CHOICE/CHECKBOXES/DROPDOWN/LINEAR_SCALE/DATE/TIME |
| `update_form_info` | Update title/description |
| `delete_item` | Delete an item by itemId |
| `list_responses` | Responses flattened + keyed by question title; filter/paging |
| `batch_update_forms_raw` | Raw Forms API requests |
</details>

<details><summary><b>Apps Script (10)</b></summary>

| Tool | Description |
|------|-------------|
| `list_script_projects` | List projects; filter by name or folder |
| `create_script_project` | Create; `parentId` binds to a Sheet/Doc/Form/Slides file |
| `get_script_project` | Metadata + source files |
| `update_script_content` | Push files; merges by name, keeps `appsscript` manifest |
| `list_script_versions` | List saved versions |
| `create_script_version` | Create an immutable version |
| `list_script_deployments` | List deployments |
| `create_script_deployment` | Deploy a version |
| `run_script_function` | Run a function via `scripts.run` (constrained — see skill) |
| `get_script_processes` | Recent executions with status/timing |
</details>

---

## Quick start — org-wide rollout (~15 min)

For a Google Workspace admin. You'll host the server on your own Google Cloud project and hand users
a single connector URL. Commands use the **gcloud CLI**; a few steps are console-only (linked).

**Prerequisites**
- A Google Cloud project with **billing enabled** (Cloud Run's free tier covers small orgs).
- [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) installed and `gcloud auth login` done.
- **Node 20+**. On Windows run the deploy script from **Git Bash** or **WSL**.
- Rights to configure the OAuth consent screen for your Workspace org.

### 1. Create & select the project

```bash
gcloud projects create your-project-id --name="Workspace MCP"
gcloud config set project your-project-id
```
Link billing in the console: <https://console.cloud.google.com/billing/linkedaccount?project=your-project-id>

Grab the project number — you'll need it for the OAuth redirect URI:
```bash
gcloud projects describe your-project-id --format='value(projectNumber)'
```

### 2. Enable the APIs

```bash
gcloud services enable \
  run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com \
  sheets.googleapis.com drive.googleapis.com docs.googleapis.com \
  slides.googleapis.com forms.googleapis.com script.googleapis.com
```

### 3. Configure the OAuth consent screen (console)

<https://console.cloud.google.com/auth/overview>

- **User type: Internal** (only your Workspace's users can log in — the tightest control).
- Add these scopes at <https://console.cloud.google.com/auth/scopes>:

  ```
  openid
  email
  https://www.googleapis.com/auth/spreadsheets
  https://www.googleapis.com/auth/drive
  https://www.googleapis.com/auth/documents
  https://www.googleapis.com/auth/presentations
  https://www.googleapis.com/auth/forms.body
  https://www.googleapis.com/auth/forms.responses.readonly
  https://www.googleapis.com/auth/script.projects
  https://www.googleapis.com/auth/script.deployments
  ```

### 4. Create the OAuth client (console)

<https://console.cloud.google.com/auth/clients> → **Create client** → **Web application**.

The redirect URI is deterministic on Cloud Run, so you can set it now (service name `sheets-mcp`,
region `europe-west1`):
```
https://sheets-mcp-PROJECT_NUMBER.europe-west1.run.app/oauth/google/callback
```
Replace `PROJECT_NUMBER` with the number from step 1. Note the generated **client id** and **client
secret**.

### 5. Clone, install, test

```bash
git clone https://github.com/your-org/google-workspace-mcp.git
cd google-workspace-mcp
npm install
npm test
```

### 6. Deploy to Cloud Run

```bash
export PROJECT_ID=your-project-id
export GOOGLE_OAUTH_CLIENT_ID=PROJECT_NUMBER-abc.apps.googleusercontent.com
export GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
export ALLOWED_DOMAINS=example.com          # comma-separated; omit to allow all
bash deploy/deploy.sh
```
The script enables APIs, creates the Firestore database, generates the token-encryption key and
stores both secrets in Secret Manager, grants IAM, deploys, and prints your **service URL**.

> **New-project build fails with a permissions error?** Grant the Cloud Build role and re-run:
> ```bash
> gcloud projects add-iam-policy-binding your-project-id \
>   --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
>   --role="roles/cloudbuild.builds.builder"
> ```

If the printed URL differs from step 4's guess, update the OAuth client's redirect URI to
`<service-url>/oauth/google/callback`.

### 7. Publish the connector to your org

<https://claude.ai/settings/connectors> → **Add custom connector** → paste:
```
https://<service-url>/mcp
```
No client id/secret to enter — Dynamic Client Registration handles it. As an admin, add it under
**Organization connectors** so everyone gets it. Claude Code picks up connectors automatically on a
new session.

### 8. Verify

In Claude: **"list my recent spreadsheets."** You'll be sent to Google to sign in once, then Claude
returns your files.

<details><summary>Optional hardening & extras</summary>

- **Firestore auto-expiry (TTL)** — let expired tokens/codes self-delete:
  ```bash
  for c in accessTokens refreshTokens authCodes pendingAuth; do
    gcloud firestore fields ttls update expiresAt --collection-group="$c" --enable-ttl --async
  done
  ```
- **Apps Script tools** — each user enables the Apps Script API once at
  <https://script.google.com/home/usersettings>.
- **Custom domain** — map one to the Cloud Run service and set `BASE_URL` to it (then update the
  redirect URI accordingly).
</details>

---

## Access tiers

The remote server exposes three MCP endpoints with different permission levels:

| Endpoint    | Tiers allowed          | Suggested audience                      |
|-------------|------------------------|-----------------------------------------|
| `/mcp`      | read + write + destructive | Trusted users, power users, admins  |
| `/mcp/write`| read + write           | Standard org members (default rollout)  |
| `/mcp/read` | read only              | Guests, reviewers, audit workflows      |

Each endpoint has its own OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp/<endpoint>`, so clients can discover
which scopes are required automatically.

**Suggested rollout:** point most users at `/mcp/write` — they can read, create,
and edit documents but cannot delete sheets/slides/items or run raw batch-update
requests. Reserve `/mcp` for power users who need the full surface.

**Tool annotations:** every tool carries MCP `ToolAnnotations` derived from its
tier (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`),
so MCP-aware clients can display intent and warn before destructive operations.

**Stdio (`TOOL_TIERS`):** the stdio entry point reads the `TOOL_TIERS` environment
variable (comma-separated, default `read,write,destructive`) and passes it to the
tool registration layer, so the same tier-filtering logic applies in headless mode.

## For admins

- **What users can do:** exactly what their own Google account can — read/write the Sheets, Docs,
  Slides, Forms and Apps Script files they already have access to. No user can reach anything they
  couldn't open in Drive themselves.
- **What they can't:** log in from outside `ALLOWED_DOMAINS` (403, nothing stored); access other
  people's private files; run arbitrary Apps Script that isn't theirs.
- **Revoke access** — per user: they visit <https://myaccount.google.com/permissions> and remove the
  app, or you disable the connector org-wide in claude.ai. `/revoke` (RFC 7009) drops the cached
  Google client immediately.
- **Audit** — because every call runs as the real user, Google Drive activity and audit logs
  attribute edits to the actual person, not a shared robot.
- **Cost** — Cloud Run scales to zero (you pay only per request); Firestore usage sits in the free
  tier for small orgs. Expect ~**$0/month** at low volume.
- **Where tokens live** — in **your** GCP project's Firestore. Each user's Google refresh token is
  **AES-256-GCM encrypted** at rest; your own access/refresh tokens are stored only as SHA-256
  hashes. Nothing is sent to third parties.
- **Rotate the OAuth secret** — create a new secret in the console, then:
  ```bash
  printf '%s' 'NEW_SECRET' | gcloud secrets versions add sheets-mcp-google-client-secret --data-file=-
  gcloud run services update sheets-mcp --region europe-west1 \
    --update-secrets GOOGLE_OAUTH_CLIENT_SECRET=sheets-mcp-google-client-secret:latest
  ```
  Do **not** rotate `TOKEN_ENCRYPTION_KEY` unless you intend to invalidate every stored refresh token
  (all users re-consent).

> **Personal Gmail / solo dev?** Same steps, with two changes in step 3: set **User type: External**
> and add yourself under **Test users**. Leave `ALLOWED_DOMAINS` unset (or set it to your address's
> domain). Everything else is identical.

---

## Quick start — local (stdio, service account)

Headless mode for cron jobs, local dev, or a single-identity setup. One service account acts on
everything shared with it.

1. Enable the same APIs (step 2 above) in a project.
2. Create a **service account** and download its JSON key
   (<https://console.cloud.google.com/iam-admin/serviceaccounts>).
3. **Share** each spreadsheet/doc/folder with the service account's email
   (`…@….iam.gserviceaccount.com`). *(Optional: domain-wide delegation + `GOOGLE_IMPERSONATE_USER`
   to act as any user in your Workspace.)*
4. `npm install && npm run build`
5. Register with Claude Code:
   ```bash
   claude mcp add google-workspace \
     -e GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/service-account.json \
     -- node /absolute/path/to/dist/stdio.js
   ```
   or add `.mcp.json` to a project:
   ```json
   {
     "mcpServers": {
       "google-workspace": {
         "command": "node",
         "args": ["/absolute/path/to/dist/stdio.js"],
         "env": { "GOOGLE_SERVICE_ACCOUNT_KEY_FILE": "/path/to/service-account.json" }
       }
     }
   }
   ```
6. **Claude Desktop** uses the same block under `mcpServers` in its config file.

---

## How auth works (remote mode)

This server is its own OAuth 2.1 Authorization Server and brokers to Google (proxy pattern).

```
claude.ai ──DCR /register──▶ MCP server
claude.ai ──/authorize (PKCE)─▶ MCP server ──▶ Google consent ──▶ /oauth/google/callback
   (verify id_token, enforce domain allowlist, store ENCRYPTED refresh token)
claude.ai ──/token──▶ MCP server  ⇒ opaque access token (1h) + rotating refresh token (30d)
claude.ai ──/mcp (Bearer)─▶ MCP server ⇒ builds a per-user Google client, runs the tool AS the user
```

1. Discovery via `/.well-known/oauth-protected-resource/mcp` + `/.well-known/oauth-authorization-server`.
2. `/authorize` redirects to Google (`access_type=offline`, `prompt=consent`).
3. `/oauth/google/callback` verifies the Google id_token, **enforces `ALLOWED_DOMAINS`**, and stores
   the user's refresh token AES-256-GCM encrypted.
4. `/token` issues an opaque access token + rotating refresh token; only SHA-256 hashes are persisted.
5. `/mcp` is a stateless Streamable HTTP endpoint behind `requireBearerAuth`.
6. State lives in **Firestore**; `expiresAt` is a Timestamp so a TTL policy auto-expires codes/tokens.

**Security**
- **Domain allowlist** — logins outside `ALLOWED_DOMAINS` get 403; nothing is stored.
- **Encrypted refresh tokens** — AES-256-GCM with `TOKEN_ENCRYPTION_KEY` before Firestore.
- **Hashed tokens** — access/refresh tokens stored as SHA-256 only; auth codes are single-use;
  refresh tokens rotate on every use.
- **Scope versioning** — bump `SCOPE_VERSION` (`src/remote/config.ts`) when scopes change to force
  every user to re-consent on their next call.
- **Revocation** — `/revoke` (RFC 7009); users can also revoke at
  <https://myaccount.google.com/permissions>.

---

## Skill

A bundled [Claude skill](skills/google-workspace) teaches Claude to use these tools well: index math
(Sheets 0-based GridRange, Docs 1-based indexes), EMU layout for Slides, and ready-to-paste raw
`batchUpdate` recipes for formatting, charts, pivots, tables, forms and bound Apps Script. Copy
`skills/google-workspace/` into a repo's `.claude/skills/` or `~/.claude/skills/`. See
[skills/README.md](skills/README.md).

---

## Configuration

| Env var | Mode | Description |
|---------|------|-------------|
| `BASE_URL` | remote | Public https URL, no trailing slash (Cloud Run service URL). |
| `GOOGLE_OAUTH_CLIENT_ID` | remote | OAuth "Web application" client id. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | remote | OAuth client secret (via Secret Manager in prod). |
| `TOKEN_ENCRYPTION_KEY` | remote | Base64 32-byte AES key (`openssl rand -base64 32`). Keep stable. |
| `ALLOWED_DOMAINS` | remote | Comma-separated email domains. Unset = allow all (warns). |
| `STORE` | remote | `firestore` (default) or `memory` (dev/tests). |
| `FIRESTORE_DATABASE` | remote | Firestore database id. Default `(default)`. |
| `PORT` | remote | Listen port. Default 8080 (Cloud Run injects it). |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | stdio | Path to the service-account JSON key. |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | stdio | …or the raw JSON (or base64) instead of a file path. |
| `GOOGLE_IMPERSONATE_USER` | stdio | Impersonate a Workspace user (domain-wide delegation). |

See [`.env.example`](.env.example) for the full annotated list.

---

## Development

```bash
npm install
npm run build        # strict TypeScript → dist/
npm test             # vitest (MemoryStore + supertest, Google mocked)
npm run dev          # remote server via tsx (needs remote env vars)
npm run dev:stdio    # stdio server via tsx (needs service-account env)
```

Layout: `src/tools/*` (shared tool implementations), `src/stdio.ts` (service-account entry),
`src/remote/*` (express app, OAuth provider, Firestore/Memory store, Google helpers, crypto,
config), `test/*` (vitest).

**Adding a new Google API**
- Request the new OAuth scope in `src/remote/config.ts` and **bump `SCOPE_VERSION`**.
- Add the scope to the consent screen and (for stdio) the service account's delegation.
- Add a `registerXxxTools(server, getClients)` module under `src/tools/` and wire it into
  `src/tools/index.ts`.
- Enable the API (`gcloud services enable …`) and add it to `deploy/deploy.sh`.

---

## License

[MIT](LICENSE)
