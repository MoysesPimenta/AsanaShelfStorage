# Operating the shelf sync

## How a shelf gets written

```
Asana task created/changed
        |  (webhook, project "Pedidos e envios" 1209435989338394)
        v
POST /api/asana-shelf-sync
        |  1. verify HMAC signature
        |  2. ACK Asana (~300ms)  <-- must happen inside 10s
        |  ---- response sent ----
        |  3. read the stock sheet (cached 5 min, stale-while-revalidate)
        |  4. XLOOKUP each serial, bottom-to-top
        |  5. write serials grouped by shelf, skipping no-ops
        v
Asana task updated
```

Steps 3-5 run inside `waitUntil`, so a slow Google Sheets read can no longer
cost Asana its delivery.

A scheduled sweep (`/api/backfill`) reconciles the board with the sheet every
15 minutes, so an event that never arrives is corrected within a quarter hour
instead of being lost.

## Storage Shelf format (since 2026-10-07)

```
A3 (2)
SH9Y3YLC37W
SFPWVD2R6RH

N3 (1)
SC6P9N7JPMY

NOT IN SHEET (1)
C02XK1ABJG5H
```

Serials grouped under their shelf, shelves in natural order, serials in Serial
Number order, so a task with many machines is picked shelf by shelf.
`NOT IN SHEET` lists serials missing from column A of the stock tab.

Rules the code follows (`buildShelfFieldValue` in `lib/sheets.ts`):

| Situation | Written value |
|---|---|
| every serial found | `A3 (2)` heading, its serials below, blank line, next shelf ... |
| some serials missing | missing ones listed last under `NOT IN SHEET (n)` |
| **no** serial found | `""` (webhook clears; sweep leaves the field alone unless `clear=1`) |
| longer than Asana's 1024-char text limit | same grouping without counts, then also without blank lines |
| still longer than 1024 chars | compact shelf-only list (old format) |

From 2026-09-18 to 2026-10-07 the field held one `SERIAL → SHELF` line per
serial. Before 2026-09-18 it held bare shelves, one per line, with a blank line
for a missing serial. The first sweep after that deploy rewrites every open
task still in the old format (a one-off burst of `changed=N` in its log line);
the webhooks those writes raise are no-ops.

## The 2026-09-02 outage (why the design changed)

Symptom: tasks kept an empty Storage Shelf for hours; nothing in the code had
changed.

What was actually happening:

```
webhook 1215883769254627
  last_success_at:      2026-09-02T13:27:38Z
  last_failure_at:      2026-09-02T14:32:36Z
  last_failure_content: ETIMEOUT: Asana was unable to connect to your webhook
                        within the timeout of 10000 ms
  delivery_retry_count: 8
  next_attempt_after:   2026-09-02T15:32:36Z   (~1h apart)
  failure_deletion_ts:  2026-09-05T13:27:38Z   (Asana would delete it)
```

The handler did every slow step *before* answering Asana. Google Sheets reads
of the stock tab are normally fast (measured 0.7-0.9s for ~7100 rows) but are
intermittently very slow - two reads that afternoon took **113s** (open-ended
`'Conferencia de estoque '!A:B`) and **281s** (bounded `A1:B20000`), the cost
being the spreadsheet recalculating on read, not the range. Once a delivery
exceeded 10s, Asana backed off exponentially; each retry then landed on a cold
instance and timed out again, so the webhook stayed dead long after the sheet
was fast again, and every event raised in between was dropped.

Fixes applied:

1. ACK first, work in `waitUntil` (`maxDuration = 300`).
2. Rows cached 5 min per range and served stale while refreshing.
3. `/api/backfill` sweep + pg_cron schedule as the safety net.

Still worth doing on the data side: if the stock tab were values-only (or the
automation pointed at a lightweight serial+shelf copy), reads would never
spike and shelves would always land within a second. Point it elsewhere with
`GOOGLE_SHEET_ID` / `GOOGLE_SHEET_RANGE`; no code change needed.

## The 2026-10-01 tab-rename outage

Symptom: Storage Shelf stopped being filled on new/edited tasks; no runtime
*errors* in Vercel (the failure was only an error-level `console.error`).

Cause: the stock tab was renamed from `Conferencia de estoque ` (trailing
space) to `Conferencia de estoque`. `GOOGLE_SHEET_RANGE` still pointed at the
old name, so every read - webhook and sweep - failed before touching Asana:

```
[asana-shelf-backfill] Failed to read Google Sheet:
  Unable to parse range: 'Conferencia de estoque '!A:B
```

Confirmed by probing `/api/backfill?dry=1&range=...` from pg_net: the old
name fails, `'Conferencia de estoque'!A:B` reads 10,058 rows in ~0.8s. Onset
is unknown - Vercel only keeps about a day of runtime logs and every sweep in
that window failed.

Fix: the reader now resolves tab-name drift itself. On `Unable to parse
range` it lists the spreadsheet's tabs, matches the configured one ignoring
whitespace, case and accents, retries, and remembers the resolved range for
the instance (`resolveRenamedTab` in `lib/sheets.ts`). A tab that was really
renamed still fails, but the error now lists the tabs that exist. The code
default for `GOOGLE_SHEET_RANGE` is the new name; the Vercel env var should be
updated to `'Conferencia de estoque'!A:B` to silence the warning.

Recovery (commit `8cd021b`, deploy `dpl_HbXtSGJVFjFZmJJvUZKeRfppQn61`): the
first sweep logged the resolver warning, read 10,068 rows and reported
`scanned=76 changed=14 correct=57 noSerial=5 failed=0` - 11 tasks had an empty
Storage Shelf and 3 showed a stale shelf (machines that had moved). The 14
webhook echoes all logged `already correct`, so deliveries were flowing the
whole time; only the sheet read was broken.

## /api/backfill

Reconciles every **open** task in the project with the stock sheet.

```bash
# what would change (writes nothing)
curl -H "Authorization: Bearer $ASANA_PAT" \
  "https://project-dztb8.vercel.app/api/backfill?dry=1"

# apply
curl -H "Authorization: Bearer $ASANA_PAT" \
  "https://project-dztb8.vercel.app/api/backfill"
```

| Param | Meaning |
|---|---|
| `dry=1` | report only, write nothing |
| `clear=1` | also blank shelves whose serials are gone from the sheet (default: never blank, only fill/correct) |
| `max=N` | stop after N tasks (default 1000) |
| `async=1` | ACK immediately and sweep in the background (used by cron) |
| `range=` | read an alternative A1 range - probe for timing the sheet |

Auth is `Bearer $CRON_SECRET` when `CRON_SECRET` is set in Vercel, otherwise
`Bearer $ASANA_PAT`.

## The scheduled sweep

Runs from Supabase pg_cron on project `tzxjjwfwbrcradxjvhnx` (same pattern as
the other Dimais jobs), at `4,19,34,49 * * * *`:

```sql
select cron.schedule(
  'asana-shelf-backfill',
  '4,19,34,49 * * * *',
  $$
  select net.http_post(
    url := 'https://project-dztb8.vercel.app/api/backfill?async=1',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ASANA_PAT'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);
```

Inspect it with `select * from cron.job where jobname = 'asana-shelf-backfill'`
and its history in `cron.job_run_details`.

## Extra environment variables

| Variable | Default | Notes |
|---|---|---|
| `GOOGLE_SHEET_TTL_MS` | `300000` | how long stock rows stay fresh before a background refresh |
| `GOOGLE_SHEET_MAX_ROWS` | `0` (off) | clamp an open-ended range to `A1:B<N>`; measured slower on this sheet, so off |
| `CRON_SECRET` | unset | preferred bearer token for `/api/backfill` |

## Checking health

```bash
# webhook delivery state - the first thing to look at when shelves stop moving
curl -s -H "Authorization: Bearer $ASANA_PAT" \
  "https://app.asana.com/api/1.0/webhooks/1215883769254627?opt_fields=active,last_success_at,last_failure_at,last_failure_content,delivery_retry_count,next_attempt_after"
```

`delivery_retry_count > 0` or a `next_attempt_after` far in the future means
Asana is backing off and events are being dropped - the sweep is what keeps the
board correct until deliveries recover.

| Symptom | Look at |
|---|---|
| Shelves stop updating for hours | webhook `delivery_retry_count` / `next_attempt_after` (above) |
| `ETIMEOUT ... within the timeout of 10000 ms` | something in the handler ran before the ACK, or the function cold-started slowly |
| A single task never gets a shelf | runtime logs: `no serials parsed` dumps every custom field on the task |
| Shelf blank though the serial exists | none of the task's serials are in column A of the stock tab (last match wins, bottom-to-top) |
| Serials under `NOT IN SHEET` | those serials are missing from column A; the others were found |
| Big task has no counts or no blank lines | the full layout exceeded Asana's 1024-char limit, a tighter one was written |
| Big task shows bare shelves, no serials | even the tightest grouped layout exceeded 1024 chars, compact fallback written |
| Sheet read logged in the tens of seconds | spreadsheet recalculation - see the outage note above |
| No shelves anywhere; backfill logs `Failed to read Google Sheet: Unable to parse range` | the stock tab was renamed - see the 2026-10-01 note |
| `[sheets] Tab "…" no longer exists; reading "…" instead` | tab name drifted cosmetically and was auto-resolved; update `GOOGLE_SHEET_RANGE` to the new name |
