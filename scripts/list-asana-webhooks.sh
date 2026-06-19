#!/usr/bin/env bash
#
# List (and optionally delete) existing Asana webhooks for the workspace.
# Useful for cleaning up duplicates while testing.
#
# Usage:
#   export ASANA_PAT=...
#   ./scripts/list-asana-webhooks.sh                 # list
#   ./scripts/list-asana-webhooks.sh delete <gid>    # delete one
#
set -euo pipefail

: "${ASANA_PAT:?Set ASANA_PAT in your environment first}"
WORKSPACE_GID="${ASANA_WORKSPACE_GID:-1209435871242085}"

if [[ "${1:-}" == "delete" && -n "${2:-}" ]]; then
  curl -sS -X DELETE "https://app.asana.com/api/1.0/webhooks/${2}" \
    -H "Authorization: Bearer ${ASANA_PAT}" | python3 -m json.tool
  exit 0
fi

curl -sS "https://app.asana.com/api/1.0/webhooks?workspace=${WORKSPACE_GID}&opt_fields=resource.name,target,active" \
  -H "Authorization: Bearer ${ASANA_PAT}" | python3 -m json.tool
