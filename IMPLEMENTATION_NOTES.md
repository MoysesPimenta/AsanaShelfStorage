# Implementation Notes

## Result

A production-ready Next.js (App Router) project implementing:

```
Asana webhook -> /api/asana-shelf-sync -> Google Sheets lookup -> Asana update
```

The code is complete and self-contained. What it still needs from you are the
**secrets** (which I do not have access to) and a couple of **dashboard
actions** that require those secrets. See the checklist at the bottom.

## What was built

- **`app/api/asana-shelf-sync/route.ts`** — the endpoint.
  - `GET` health check returning `{ ok: true, service: "asana-shelf-sync" }`.
  - `POST` handles the Asana `X-Hook-Secret` handshake (echoes the header,
    logs the secret, does no event processing).
  - Verifies `X-Hook-Signature` as HMAC-SHA256 over the **raw** request body,
    using `crypto.timingSafeEqual` (length-checked first). Invalid → `401`.
  - Extracts + dedupes task GIDs, reads the sheet once per batch, processes each
    task independently (one failure never aborts the rest), always returns `200`
    on real events so Asana keeps the webhook active.
- **`lib/asana.ts`** — native `fetch` calls. Reads
  `name, custom_fields.{gid,name,display_value,text_value,number_value,enum_value.name}`.
  Updates via `PUT /tasks/{gid}` with `custom_fields: { <shelfGid>: value }`.
- **`lib/sheets.ts`** — `googleapis` JWT (service account, read-only scope).
  Reads `GOOGLE_SHEET_RANGE` and scans **bottom-to-top** for the last exact
  match; normalizes serials with `trim().toUpperCase()`; returns `""` when not
  found (matches the XLOOKUP `""` default).
- **`lib/config.ts`** — centralized env access. Non-secret Asana GIDs have
  defaults; `GOOGLE_PRIVATE_KEY` has its escaped `\n` converted to real
  newlines.
- **Scripts** — `create-asana-webhook.sh` (project-scoped, task added/changed
  filters, reads `ASANA_PAT` from env), `list-asana-webhooks.sh`.

## Key design decisions

- **Framework: Next.js App Router.** The target Vercel project
  (`project-dztb8`) was empty (`framework: null`, never deployed), so there was
  no existing structure to match. App Router route handlers give clean access to
  the raw body (`await req.text()`) which is required for HMAC verification, and
  Vercel auto-detects Next.js with zero config.
- **Node runtime** (`export const runtime = "nodejs"`), not Edge, because
  `googleapis` and `node:crypto` need Node APIs.
- **Anti-loop:** writing Storage Shelf fires another `changed` event, but the
  recomputed shelf equals the current value, so the second pass is a logged
  no-op. The `newShelf === currentShelf` guard is the loop breaker.
- **Bootstrap window:** if `ASANA_WEBHOOK_SECRET` is unset, the endpoint cannot
  verify signatures, so it logs a warning and returns `200` without processing
  (rather than 401-ing or processing unverified data). This is expected only
  between webhook creation and the redeploy that activates the secret.
- **Single sheet read per batch** avoids N reads for N tasks in one delivery.

## Verification performed

- See the "Verification" section of the chat summary for the exact
  `npm install` + build/typecheck results captured at delivery time.

## Risks / known gaps

- The Asana webhook delivery timeout is ~10s. For a normal batch (a few tasks)
  this is fine; a very large batch with many sequential Asana reads/writes could
  approach the limit. If that ever happens, switch to acknowledging `200`
  immediately and processing via a queue/background function.
- The tab name trailing space is assumed present (per the formula). If the tab
  is renamed, set `GOOGLE_SHEET_RANGE` accordingly.
- Serial comparison is `trim().toUpperCase()`. If the real data needs different
  normalization (e.g. stripping leading zeros), adjust `normalizeSerial`.

## Outstanding setup checklist (needs secrets I don't have)

These are the ONLY things blocking a fully live automation. The code does not
need to change for any of them.

- [ ] `ASANA_PAT` — create/locate the token, add to Vercel env vars.
- [ ] `GOOGLE_SERVICE_ACCOUNT_EMAIL` — service account client email.
- [ ] `GOOGLE_PRIVATE_KEY` — service account private key (share the sheet with
      this account; enable Sheets API).
- [ ] `GOOGLE_SHEET_ID` — the spreadsheet ID.
- [ ] Confirm `GOOGLE_SHEET_RANGE` (default `Conferencia de estoque !A:B`).
- [ ] Deploy with `ASANA_WEBHOOK_SECRET` empty.
- [ ] Run `scripts/create-asana-webhook.sh` with `ASANA_PAT` + `TARGET_URL`.
- [ ] Copy `ASANA_WEBHOOK_SECRET` from Vercel runtime logs → env vars → redeploy.
- [ ] Test by editing a task's Serial Number.
```
