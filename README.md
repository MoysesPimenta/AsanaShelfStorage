# Asana Shelf Sync

Automation that keeps an Asana task's **Storage Shelf** field in sync with a
value looked up from a Google Sheet, based on the task's **Serial Number**.

```
Asana task created/changed
        │  (webhook)
        ▼
Vercel  POST /api/asana-shelf-sync
        │  1. verify HMAC signature
        │  2. read Serial Number from the task
        │  3. XLOOKUP serial in Google Sheet (bottom-to-top, last match)
        │  4. write the shelf into Storage Shelf (skip no-ops)
        ▼
Asana task updated
```

It reproduces this Google Sheets formula:

```
=ARRAYFORMULA(IF(D2:D="";"";XLOOKUP(D2:D;'Conferencia de estoque '!A:A;'Conferencia de estoque '!B:B;"";0;-1)))
```

`XLOOKUP(..., 0, -1)` = exact match, scanning from the **last** row to the
first, returning `""` when nothing matches. The endpoint scans the sheet
bottom-to-top so the **latest** matching serial wins.

## Endpoint

- `GET /api/asana-shelf-sync` → `{ "ok": true, "service": "asana-shelf-sync" }`
- `POST /api/asana-shelf-sync` → Asana webhook handshake + event processing

## Project layout

```
app/
  api/asana-shelf-sync/route.ts   # the webhook endpoint (Next.js App Router)
  layout.tsx, page.tsx            # minimal landing page
lib/
  config.ts                       # env access + defaults
  asana.ts                        # read task fields, update field, parse events
  sheets.ts                       # service-account auth + bottom-to-top lookup
scripts/
  create-asana-webhook.sh         # register the webhook
  list-asana-webhooks.sh          # list / delete webhooks
```

## Required environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (and in
`.env.local` for local dev). See `.env.example`.

| Variable | Required | Notes |
|---|---|---|
| `ASANA_PAT` | yes (secret) | Personal Access Token with read/write on the project |
| `ASANA_PROJECT_GID` | default baked in | `1209435989338394` |
| `ASANA_WORKSPACE_GID` | default baked in | `1209435871242085` |
| `ASANA_SERIAL_CUSTOM_FIELD_GID` | default baked in | `1209458789411568` (Serial Number) |
| `ASANA_SHELF_CUSTOM_FIELD_GID` | default baked in | `1215845672985246` (Storage Shelf) |
| `ASANA_WEBHOOK_SECRET` | yes (secret) | Leave empty for first deploy; fill from handshake log |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | yes (secret) | Service account that can read the sheet |
| `GOOGLE_PRIVATE_KEY` | yes (secret) | Escaped `\n` is auto-converted to newlines |
| `GOOGLE_SHEET_ID` | yes | Spreadsheet ID from the sheet URL |
| `GOOGLE_SHEET_RANGE` | default baked in | `Conferencia de estoque !A:B` (note trailing space in tab name) |

> The tab name currently appears to have a **trailing space** after
> `estoque`. The default range preserves it. If the tab was renamed, override
> `GOOGLE_SHEET_RANGE`.

### Google service account setup

1. In Google Cloud Console, create a service account and a JSON key.
2. Enable the **Google Sheets API** for that project.
3. Share the spreadsheet with the service account email (Viewer is enough).
4. Put the `client_email` into `GOOGLE_SERVICE_ACCOUNT_EMAIL` and the
   `private_key` into `GOOGLE_PRIVATE_KEY` (wrap in quotes; escaped `\n` is fine).

## Deploying the code to Vercel

The target project already exists: **`project-dztb8`** (team
`moysespimentas-projects`, id `prj_pvsCuswLnorch51TWESR3g7u9zXi`). Do **not**
create a new one. Link to the existing project using the Vercel CLI from this
folder:

```bash
cd "Asana Shelf Storage"
npm i -g vercel        # if not installed
vercel login
vercel link --yes --project project-dztb8 --scope moysespimentas-projects
vercel deploy --prod   # builds and deploys to the existing project
```

Alternatively, push this folder to a Git repo and connect that repo to
`project-dztb8` in the Vercel dashboard (Settings → Git); pushes then auto-deploy.

Set environment variables either with `vercel env add <NAME> production` or in
the dashboard (Settings → Environment Variables) before the production deploy.

## Deploy + webhook setup (step by step)

1. **Deploy** the project to Vercel with `ASANA_WEBHOOK_SECRET` empty/unset.
   Set all the other env vars (`ASANA_PAT`, the Google ones, `GOOGLE_SHEET_ID`).
2. **Verify health:** open `https://<your-app>.vercel.app/api/asana-shelf-sync`
   — it should return the health JSON.
3. **Create the webhook** (the endpoint must be live first):
   ```bash
   export ASANA_PAT=...   # your token
   export TARGET_URL=https://<your-app>.vercel.app/api/asana-shelf-sync
   ./scripts/create-asana-webhook.sh
   ```
   Asana immediately calls the endpoint with the handshake.
4. **Capture the secret:** open the Vercel **runtime logs** for the deployment.
   Find the line:
   ```
   ASANA_WEBHOOK_SECRET=<value>
   ```
5. **Save it:** add `ASANA_WEBHOOK_SECRET=<value>` to Vercel env vars.
6. **Redeploy** so the new env var takes effect.
7. **Test:** edit the **Serial Number** field on a task in the project. Within a
   few seconds the **Storage Shelf** field should update to the matching shelf.

## How it behaves (acceptance criteria)

- Serial Number empty → task skipped.
- Storage Shelf already equal to the looked-up value → skipped (no write).
- Serial found → Storage Shelf set to the last matching row's shelf.
- Serial not found → Storage Shelf cleared to `""` (matches the formula).
- Updating Storage Shelf triggers another webhook, but the next run is a no-op
  (computed shelf == current), so **no infinite loop**.
- Invalid `X-Hook-Signature` → `401`.
- All secrets stay in environment variables; only the handshake secret is
  logged, and only so you can copy it during setup.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Health check 404 | Endpoint not deployed, or wrong path. Confirm `/api/asana-shelf-sync`. |
| Webhook create returns the handshake never completes | Endpoint not reachable / not yet deployed, or it didn't echo `X-Hook-Secret`. |
| `401 Invalid signature` on every event | `ASANA_WEBHOOK_SECRET` not set, wrong value, or not redeployed after setting it. |
| Logs show `ASANA_PAT is not configured` | Set `ASANA_PAT` in Vercel and redeploy. |
| Logs show `Failed to read Google Sheet` | Sheet not shared with the service account, wrong `GOOGLE_SHEET_ID`, wrong tab name/range, or Sheets API not enabled. |
| Shelf always clears to blank | Serial not matching: check the tab name's trailing space and that column A/B are correct. |
| Nothing happens on edit | Webhook inactive or filtered. Run `scripts/list-asana-webhooks.sh` to inspect. |

See `IMPLEMENTATION_NOTES.md` for design details and the outstanding setup
checklist.
