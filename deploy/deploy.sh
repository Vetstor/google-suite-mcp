#!/usr/bin/env bash
#
# Deploy the remote Google Sheets MCP server to Cloud Run.
#
# Prerequisites:
#   - gcloud CLI authenticated (gcloud auth login) with rights on $PROJECT_ID
#   - A Google OAuth 2.0 "Web application" client already created, whose
#     redirect URI you will set to  https://<service-url>/oauth/google/callback
#     (re-run once after the first deploy prints the URL).
#
# Required env:
#   PROJECT_ID                     GCP project id
#   GOOGLE_OAUTH_CLIENT_ID         OAuth client id (…apps.googleusercontent.com)
#   GOOGLE_OAUTH_CLIENT_SECRET     OAuth client secret (only used to create the
#                                  Secret Manager secret the first time)
# Optional env:
#   ALLOWED_DOMAINS                comma-separated allowlist, e.g. "vetstor.cz"
#   SERVICE_NAME     (default: sheets-mcp)
#   REGION           (default: europe-west1)
#   FIRESTORE_LOCATION (default: europe-west1)
#   BASE_URL         override (e.g. a custom domain); otherwise auto-detected
#
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${GOOGLE_OAUTH_CLIENT_ID:?Set GOOGLE_OAUTH_CLIENT_ID}"

SERVICE_NAME="${SERVICE_NAME:-sheets-mcp}"
REGION="${REGION:-europe-west1}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-europe-west1}"
ALLOWED_DOMAINS="${ALLOWED_DOMAINS:-}"

SECRET_CLIENT="sheets-mcp-google-client-secret"
SECRET_TOKENKEY="sheets-mcp-token-key"

echo ">> Project: $PROJECT_ID  Service: $SERVICE_NAME  Region: $REGION"
gcloud config set project "$PROJECT_ID" >/dev/null

echo ">> Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  sheets.googleapis.com \
  drive.googleapis.com

echo ">> Ensuring Firestore (native) database exists in $FIRESTORE_LOCATION..."
if ! gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  gcloud firestore databases create \
    --location="$FIRESTORE_LOCATION" \
    --type=firestore-native
else
  echo "   Firestore database already exists."
fi

echo ">> Ensuring secrets exist..."
if ! gcloud secrets describe "$SECRET_CLIENT" >/dev/null 2>&1; then
  : "${GOOGLE_OAUTH_CLIENT_SECRET:?Set GOOGLE_OAUTH_CLIENT_SECRET to create $SECRET_CLIENT}"
  printf '%s' "$GOOGLE_OAUTH_CLIENT_SECRET" | \
    gcloud secrets create "$SECRET_CLIENT" --data-file=- --replication-policy=automatic
  echo "   Created $SECRET_CLIENT."
else
  echo "   $SECRET_CLIENT already exists (leaving as-is)."
fi

if ! gcloud secrets describe "$SECRET_TOKENKEY" >/dev/null 2>&1; then
  openssl rand -base64 32 | tr -d '\n' | \
    gcloud secrets create "$SECRET_TOKENKEY" --data-file=- --replication-policy=automatic
  echo "   Created $SECRET_TOKENKEY (generated 32-byte key)."
else
  echo "   $SECRET_TOKENKEY already exists (leaving as-is)."
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo ">> Granting IAM to runtime service account ($RUNTIME_SA)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/datastore.user" \
  --condition=None >/dev/null

# ---------------------------------------------------------------------------
# Deploy. BASE_URL must equal the service's public URL. If not supplied, deploy
# once with a placeholder to reserve the URL, then update BASE_URL in place.
# ---------------------------------------------------------------------------
ENV_COMMON="GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID},ALLOWED_DOMAINS=${ALLOWED_DOMAINS},STORE=firestore"
SECRETS="GOOGLE_OAUTH_CLIENT_SECRET=${SECRET_CLIENT}:latest,TOKEN_ENCRYPTION_KEY=${SECRET_TOKENKEY}:latest"

deploy() {
  local base_url="$1"
  gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --region "$REGION" \
    --allow-unauthenticated \
    --set-env-vars "BASE_URL=${base_url},${ENV_COMMON}" \
    --set-secrets "$SECRETS"
}

if [[ -z "${BASE_URL:-}" ]]; then
  echo ">> No BASE_URL provided; initial deploy to reserve the service URL..."
  deploy "https://placeholder.invalid"
  BASE_URL="$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')"
  echo ">> Detected service URL: $BASE_URL"
  echo ">> Updating BASE_URL in place..."
  gcloud run services update "$SERVICE_NAME" --region "$REGION" \
    --update-env-vars "BASE_URL=${BASE_URL}"
else
  echo ">> Deploying with BASE_URL=$BASE_URL"
  deploy "$BASE_URL"
fi

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')"

cat <<EOF

============================================================
Deployed: $SERVICE_URL

NEXT STEPS
1. In Google Cloud Console -> APIs & Services -> Credentials, open your
   OAuth 2.0 Web client and add this Authorized redirect URI:
       ${SERVICE_URL}/oauth/google/callback
2. In claude.ai -> Settings -> Connectors -> Add custom connector:
       ${SERVICE_URL}/mcp
   (No client id/secret needed — dynamic client registration handles it.)
3. Health check:  curl ${SERVICE_URL}/health
============================================================
EOF
