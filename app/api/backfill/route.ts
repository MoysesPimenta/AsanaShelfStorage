// Backfill sweep: recompute Storage Shelf for every open task in the project.
//
// Why this exists: the Asana webhook is best-effort. When a delivery times out
// Asana backs off exponentially and the events raised in the meantime are gone
// for good, so tasks silently keep a stale/empty Storage Shelf. This endpoint
// reconciles the board with the stock sheet, so a missed event costs at most
// one sweep interval instead of being lost forever.
//
// Auth: Bearer token equal to CRON_SECRET when that is set, otherwise equal to
// ASANA_PAT (no new secret needed - anyone holding the PAT can already write
// these fields directly).
//
// Usage:
//   curl -H "Authorization: Bearer $ASANA_PAT" \
//        "https://project-dztb8.vercel.app/api/backfill?dry=1"
//
// Query params:
//   dry=1     report what would change, write nothing
//   clear=1   also blank shelves whose serials are no longer in the sheet
//             (default: never blank a shelf, only fill/correct it)
//   max=N     stop after N tasks (default 1000)
//   async=1   ACK immediately and sweep in the background (for cron callers
//             such as pg_net, which stop reading the response after seconds)
//   range=... read an alternative A1 range (probe for tuning the sheet read)

import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { ASANA_API_BASE, config } from "@/lib/config";
import {
  AsanaTask,
  findCustomField,
  readTextFieldValue,
  updateTaskCustomField,
} from "@/lib/asana";
import { buildShelfFieldValue, readStockRows, splitSerials } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SERVICE = "asana-shelf-backfill";

const LIST_OPT_FIELDS = [
  "name",
  "completed",
  "custom_fields.gid",
  "custom_fields.name",
  "custom_fields.display_value",
  "custom_fields.text_value",
  "custom_fields.number_value",
  "custom_fields.enum_value.name",
].join(",");

interface SweepOptions {
  dryRun: boolean;
  allowClear: boolean;
  max: number;
  rangeOverride?: string;
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const options: SweepOptions = {
    dryRun: url.searchParams.get("dry") === "1",
    allowClear: url.searchParams.get("clear") === "1",
    max: Number(url.searchParams.get("max") ?? "1000") || 1000,
    rangeOverride: url.searchParams.get("range") ?? undefined,
  };

  if (url.searchParams.get("async") === "1") {
    waitUntil(
      sweep(options).catch((err) =>
        console.error(`[${SERVICE}] sweep failed:`, errMessage(err)),
      ),
    );
    return Response.json({ ok: true, started: true });
  }

  const summary = await sweep(options);
  return Response.json(summary, { status: summary.ok ? 200 : 502 });
}

// Vercel Cron issues GETs; POST is here so the sweep can also be triggered by
// the existing pg_cron/pg_net jobs, which post.
export const POST = GET;

async function sweep(options: SweepOptions) {
  const { dryRun, allowClear, max, rangeOverride } = options;
  const startedAt = Date.now();

  let stockRows: string[][];
  let sheetMs = 0;
  try {
    const t0 = Date.now();
    stockRows = await readStockRows(true, rangeOverride);
    sheetMs = Date.now() - t0;
  } catch (err) {
    console.error(`[${SERVICE}] Failed to read Google Sheet:`, errMessage(err));
    return { ok: false as const, error: "sheet_read_failed" };
  }

  const changes: Array<{ gid: string; name: string; from: string; to: string }> = [];
  const failures: Array<{ gid: string; error: string }> = [];
  let scanned = 0;
  let noSerial = 0;
  let alreadyCorrect = 0;
  let skippedBlank = 0;

  for await (const task of listOpenTasks(max)) {
    scanned++;
    const serials = splitSerials(readTextFieldValue(findCustomField(task, config.asana.serialFieldGid)));
    if (serials.length === 0) {
      noSerial++;
      continue;
    }
    const currentShelf = readTextFieldValue(findCustomField(task, config.asana.shelfFieldGid));
    const newShelf = buildShelfFieldValue(stockRows, serials);

    if (equalIgnoringWhitespace(currentShelf, newShelf)) {
      alreadyCorrect++;
      continue;
    }
    // Non-destructive default: never wipe a shelf just because the serial is
    // missing from the sheet - that is what clear=1 is for.
    if (!allowClear && newShelf.trim() === "") {
      skippedBlank++;
      continue;
    }

    changes.push({ gid: task.gid, name: task.name ?? "", from: currentShelf, to: newShelf });

    if (!dryRun) {
      try {
        await updateTaskCustomField(task.gid, config.asana.shelfFieldGid, newShelf);
      } catch (err) {
        failures.push({ gid: task.gid, error: errMessage(err) });
      }
    }
  }

  const summary = {
    ok: true as const,
    dryRun,
    allowClear,
    scanned,
    sheetRows: stockRows.length,
    sheetMs,
    changed: changes.length,
    alreadyCorrect,
    noSerial,
    skippedBlank,
    failed: failures.length,
    ms: Date.now() - startedAt,
    changes,
    failures,
  };
  console.log(
    `[${SERVICE}] scanned=${scanned} changed=${changes.length} correct=${alreadyCorrect} ` +
      `noSerial=${noSerial} skippedBlank=${skippedBlank} failed=${failures.length} ` +
      `sheetMs=${sheetMs} dry=${dryRun} in ${summary.ms}ms` +
      (changes.length
        ? ` | ${changes
            .map((c) => `${c.gid} ${JSON.stringify(c.from)}->${JSON.stringify(c.to)}`)
            .join("; ")}`
        : ""),
  );
  return summary;
}

/** Page through the project's incomplete tasks. */
async function* listOpenTasks(max: number): AsyncGenerator<AsanaTask> {
  let offset: string | null = null;
  let yielded = 0;

  for (;;) {
    const params = new URLSearchParams({
      project: config.asana.projectGid,
      completed_since: "now", // incomplete tasks only
      limit: "100",
      opt_fields: LIST_OPT_FIELDS,
    });
    if (offset) params.set("offset", offset);

    const res = await fetch(`${ASANA_API_BASE}/tasks?${params.toString()}`, {
      headers: { Authorization: `Bearer ${config.asana.pat}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Asana list tasks failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as {
      data: AsanaTask[];
      next_page?: { offset?: string } | null;
    };

    for (const task of json.data ?? []) {
      if (yielded >= max) return;
      yielded++;
      yield task;
    }

    offset = json.next_page?.offset ?? null;
    if (!offset) return;
  }
}

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "").trim();
  const expected = (process.env.CRON_SECRET || config.asana.pat || "").trim();
  if (!expected || !presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function equalIgnoringWhitespace(a: string, b: string): boolean {
  if (a === b) return true;
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
