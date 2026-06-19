#!/usr/bin/env bash
#
# Create the Asana webhook for the shelf-sync endpoint.
#
# The webhook resource is the PROJECT, so we receive task added/changed events.
# Asana performs the X-Hook-Secret handshake against the target URL when this
# runs, so the endpoint MUST already be deployed and reachable.
#
# Usage:
#   export ASANA_PAT=...                       # required (never hardcode it)
#   export TARGET_URL=https://<your-app>.vercel.app/api/asana-shelf-sync
#   ./scripts/create-asana-webhook.sh
#
# Optional overrides:
#   export ASANA_PROJECT_GID=1209435989338394
#
set -euo pipefail

: "${ASANA_PAT:?Set ASANA_PAT in your environment first}"
: "${TARGET_URL:?Set TARGET_URL to your deployed https endpoint}"
PROJECT_GID="${ASANA_PROJECT_GID:-1209435989338394}"

echo "Creating webhook:"
echo "  resource (project) = ${PROJECT_GID}"
echo "  target             = ${TARGET_URL}"
echo

curl -sS -X POST "https://app.asana.com/api/1.0/webhooks" \
  -H "Authorization: Bearer ${ASANA_PAT}" \
  -H "Content-Type: application/json" \
  -d @- <<JSON | python3 -m json.tool
{
  "data": {
    "resource": "${PROJECT_GID}",
    "target": "${TARGET_URL}",
    "filters": [
      { "resource_type": "task", "action": "added" },
      { "resource_type": "task", "action": "changed" }
    ]
  }
}
JSON

echo
echo "If this succeeded, Asana already called your endpoint with the handshake."
echo "Open your Vercel runtime logs, copy the printed ASANA_WEBHOOK_SECRET=...,"
echo "save it in Vercel env vars, and redeploy."
