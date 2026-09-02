// Asana webhook -> Google Sheets lookup -> Asana custom field update.
//
// Flow:
//   1. Asana sends an initial handshake POST with an X-Hook-Secret header.
//      We echo that header back with a 200 and log the secret so it can be
//      saved into Vercel as ASANA_WEBHOOK_SECRET.
//   2. Subsequent event POSTs carry an X-Hook-Signature header (HMAC-SHA256 of
//      the raw body using the secret). We verify it with a timing-safe compare.
//   3. We ACK Asana immediately (its delivery timeout is 10s) and do the real
//      work - sheet read + task read + field write - in the background via
//      waitUntil. Doing the work inline used to blow the 10s budget, which put
//      the webhook into Asana's exponential retry back-off and silently dropped
//      events (shelves never got filled).

import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { config } from "@/lib/config";
import {
  extractTaskGids,
  findCustomField,
  getTask,
  readTextFieldValue,
  updateTaskCustomField,
} from "@/lib/asana";
import { lookupShelvesJoined, readStockRows, splitSerials } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Background processing runs after the response is sent but still counts
// towards the function's wall clock, so give it room.
export const maxDuration = 60;

const SERVICE = "asana-shelf-sync";

// How many tasks from one delivery are processed concurrently.
const TASK_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// GET: health check
// ---------------------------------------------------------------------------
export async function GET() {
  return Response.json({ ok: true, service: SERVICE });
}

// ---------------------------------------------------------------------------
// POST: webhook handshake + event processing
// ---------------------------------------------------------------------------
export async function POST(req: Request): Promise<Response> {
  // Raw body is required for signature verification - read it as text first.
  const rawBody = await req.text();

  // --- 1. Handshake -------------------------------------------------------
  const hookSecret = req.headers.get("x-hook-secret");
  if (hookSecret) {
    // This is the ONLY place we intentionally log the secret, because it must
    // be copied into Vercel env vars. Do not process events during handshake.
    console.log(
      `[${SERVICE}] HANDSHAKE received. Save this as ASANA_WEBHOOK_SECRET in Vercel:\n` +
        `ASANA_WEBHOOK_SECRET=${hookSecret}`,
    );
    return new Response(null, {
      status: 200,
      headers: { "X-Hook-Secret": hookSecret },
    });
  }

  // --- 2. Verify signature ------------------------------------------------
  const signature = req.headers.get("x-hook-signature");
  if (!config.asana.webhookSecret) {
    // Bootstrap window: webhook created but secret not yet saved/redeployed.
    console.warn(
      `[${SERVICE}] ASANA_WEBHOOK_SECRET not configured - cannot verify signature. ` +
        `Skipping event processing. Save the handshake secret and redeploy.`,
    );
    return new Response(JSON.stringify({ ok: true, skipped: "no_secret" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!signature || !verifySignature(rawBody, signature, config.asana.webhookSecret)) {
    console.warn(`[${SERVICE}] Invalid or missing X-Hook-Signature - rejecting.`);
    return new Response("Invalid signature", { status: 401 });
  }

  // --- 3. Parse + hand off ------------------------------------------------
  let payload: { events?: unknown };
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    console.warn(`[${SERVICE}] Could not parse JSON body.`);
    return new Response(JSON.stringify({ ok: true, skipped: "bad_json" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const events = payload.events ?? [];
  const eventCount = Array.isArray(events) ? events.length : 0;
  const taskGids = extractTaskGids(events);
  console.log(
    `[${SERVICE}] Received ${eventCount} event(s); ${taskGids.length} unique task GID(s): ` +
      `${taskGids.join(", ") || "(none)"}`,
  );

  if (taskGids.length > 0) {
    // Never await here: Asana drops the delivery (and backs off) after 10s.
    waitUntil(processBatch(taskGids));
  }

  // Always 200 so Asana does not disable the webhook for transient issues.
  return Response.json({ ok: true, queued: taskGids.length });
}

// ---------------------------------------------------------------------------
// Background work
// ---------------------------------------------------------------------------

async function processBatch(taskGids: string[]): Promise<void> {
  const startedAt = Date.now();

  let stockRows: string[][];
  try {
    stockRows = await readStockRows();
  } catch (err) {
    console.error(`[${SERVICE}] Failed to read Google Sheet:`, errMessage(err));
    return;
  }

  const queue = [...taskGids];
  const workers = Array.from({ length: Math.min(TASK_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const gid = queue.shift();
      if (!gid) return;
      try {
        await processTask(gid, stockRows);
      } catch (err) {
        // One bad task must not stop the rest.
        console.error(`[${SERVICE}] Task ${gid} failed:`, errMessage(err));
      }
    }
  });
  await Promise.all(workers);

  console.log(
    `[${SERVICE}] Batch of ${taskGids.length} task(s) done in ${Date.now() - startedAt}ms ` +
      `(${stockRows.length} sheet rows).`,
  );
}

async function processTask(taskGid: string, stockRows: string[][]): Promise<void> {
  const task = await getTask(taskGid);

  const serialField = findCustomField(task, config.asana.serialFieldGid);
  const shelfField = findCustomField(task, config.asana.shelfFieldGid);

  // A task may carry one or several serials (newline/comma separated).
  const serials = splitSerials(readTextFieldValue(serialField));
  const currentShelf = readTextFieldValue(shelfField);

  if (serials.length === 0) {
    // Diagnostic: show whether the serial field was found, its raw value, and
    // every custom field on the task (name#gid=value) so we can locate where
    // the serial actually lives if it isn't in the expected field.
    const rawSerial = readTextFieldValue(serialField);
    const fieldsDump = (task.custom_fields ?? [])
      .map(
        (f) =>
          `${f.name ?? "?"}#${f.gid}=${JSON.stringify(
            f.display_value ?? f.text_value ?? f.enum_value?.name ?? null,
          )}`,
      )
      .join(" | ");
    console.log(
      `[${SERVICE}] Task ${taskGid} skipped: no serials parsed. ` +
        `serialFieldGid=${config.asana.serialFieldGid} found=${Boolean(serialField)} ` +
        `rawValue=${JSON.stringify(rawSerial)} | taskName=${JSON.stringify(task.name ?? null)} ` +
        `| fields: ${fieldsDump}`,
    );
    return;
  }

  // One shelf per serial, in order, joined by newlines (blank line if missing).
  const newShelf = lookupShelvesJoined(stockRows, serials);

  if (shelvesEqual(currentShelf, newShelf)) {
    console.log(
      `[${SERVICE}] Task ${taskGid} skipped: Storage Shelf already correct ` +
        `(${serials.length} serial(s)).`,
    );
    return;
  }

  await updateTaskCustomField(taskGid, config.asana.shelfFieldGid, newShelf);
  console.log(
    `[${SERVICE}] Task ${taskGid} updated: ${serials.length} serial(s) ` +
      `[${serials.join(" | ")}] shelf ${JSON.stringify(currentShelf)} -> ${JSON.stringify(newShelf)}.`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compare shelf values for the anti-loop guard. Exact match is the common case;
 * the whitespace-insensitive fallback ensures that if Asana stores our
 * newline-joined value with altered whitespace (e.g. spaces instead of line
 * breaks), the next webhook is still treated as a no-op rather than looping.
 */
function shelvesEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const stripWs = (s: string) => s.replace(/\s+/g, "");
  return stripWs(a) === stripWs(b);
}

/** HMAC-SHA256 verification with a timing-safe comparison. */
function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
