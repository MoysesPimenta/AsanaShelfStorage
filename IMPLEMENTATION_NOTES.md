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

## Change log

### 2026-09-18 — serial + shelf on every Storage Shelf line

**What changed.** `lookupShelvesJoined` (one bare shelf per line, blank line
when missing) was replaced by `buildShelfFieldValue` in `lib/sheets.ts`, which
writes `SERIAL → SHELF` per line and `SERIAL → ?` for a serial that is not in
the sheet. Both callers — the webhook (`app/api/asana-shelf-sync/route.ts`) and
the sweep (`app/api/backfill/route.ts`) — use it; nothing else changed.

**Why.** With several machines on one task the operator had to scroll between
Serial Number and Storage Shelf to pair each shelf with its serial. The field is
now a self-contained picking list.

**Behaviour kept on purpose.**
- "No serial matches" still yields `""`, so the webhook clears the field like
  the original XLOOKUP formula and the sweep's non-destructive default
  (`skippedBlank`) keeps protecting hand-typed shelves.
- Bottom-to-top last-match lookup, `trim().toUpperCase()` matching, and the
  `SERIAL - description` parsing are untouched; the serial is echoed as typed.
- The anti-loop guard is unchanged: the value is deterministic, so the webhook
  raised by our own write recomputes the same string and is a no-op.

**New guard.** Asana text custom fields are limited to 1024 characters
(developers.asana.com custom-fields guide). If the detailed form would exceed
that, the compact shelf-only list is written instead of failing the PUT.

**Verification.** `tsc --noEmit` clean for `app/` + `lib/`; `next build`
succeeds (Linux, Node 22); 10 assertion checks on the pure function (single,
multi, partial, none, real `SERIAL - description` input, last-match-wins,
case-insensitive match, 1024-char fallback and non-fallback, determinism).
Production check after deploy: the sweep's `changed=N` log line and webhook
`updated:` lines should carry the new `SERIAL → SHELF` values with no errors.

**Migration.** No data migration step: the 15-minute sweep detects every open
task whose value differs from the computed one and rewrites it, so the board
converges within one or two sweeps of the deploy.

**Known gaps / follow-ups.**
- `package-lock.json` in the repo predates `@vercel/functions` (Vercel's
  `npm install` tolerates it). Commit the refreshed lockfile from a machine
  with GitHub credentials so installs are reproducible.
- The `no serials parsed` diagnostic log dumps every custom field of the task,
  including customer address/phone; consider trimming it now that the field
  location is known.
