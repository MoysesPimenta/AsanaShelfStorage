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
        |  5. write Storage Shelf, skipping no-ops
        v
Asana task updated
```

Steps 3-5 run inside `waitUntil`, so a slow Google Sheets read can no longer
cost Asana its delivery.

A scheduled sweep (`/api/backfill`) reconciles the board with the sheet every
15 minutes, so an event that never arrives is corrected within a quarter hour
instead of being lost.

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
| Shelf blank though the serial exists | serial not in column A of the stock tab (last match wins, bottom-to-top) |
| Sheet read logged in the tens of seconds | spreadsheet recalculation - see the outage note above |
