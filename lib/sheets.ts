// Google Sheets lookup that reproduces:
//   =ARRAYFORMULA(IF(D2:D="";"";XLOOKUP(D2:D;'Conferencia de estoque '!A:A;
//     'Conferencia de estoque '!B:B;"";0;-1)))
//
// XLOOKUP(..., 0, -1) = exact match, searching from the LAST row to the FIRST,
// returning "" when not found. We replicate that by scanning bottom-to-top.

import { google } from "googleapis";
import { config } from "./config";

/** Normalize a serial for comparison: trim whitespace, uppercase. */
export function normalizeSerial(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Split a Serial Number field value into individual serials.
 *
 * Entry separators: newlines and commas. Semicolons are NOT separators because
 * a serial may legitimately contain a ";".
 *
 * Each entry may be written as "SERIAL - description" (e.g.
 * "SH9Y3YLC37W - Iphones"), so we keep only the part BEFORE the first
 * " - " / " – " / " — " (whitespace-dash-whitespace). A dash without surrounding
 * spaces is preserved, so hyphenated serials like "ABC-123" stay intact.
 *
 * Blank tokens (from trailing/double separators) are dropped, but a non-empty
 * serial that simply isn't in the sheet is kept so it can produce an aligned
 * blank line in the output.
 */
export function splitSerials(value: unknown): string[] {
  return String(value ?? "")
    .split(/[\r\n,]+/)
    .map((entry) => entry.split(/\s[-–—]\s/)[0].trim())
    .filter((s) => s.length > 0);
}

/**
 * Look up shelves for one or more serials and join them, in input order, with
 * newlines. A serial that isn't found contributes an empty string (blank line),
 * keeping positions aligned with the serials. Returns "" when there are no
 * serials at all.
 */
export function lookupShelvesJoined(rows: string[][], serials: string[]): string {
  return serials.map((s) => lookupShelf(rows, s)).join("\n");
}

let cachedClient: ReturnType<typeof google.sheets> | null = null;

function getSheetsClient() {
  if (cachedClient) return cachedClient;
  if (!config.google.serviceAccountEmail || !config.google.privateKey) {
    throw new Error(
      "Google credentials missing (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY)",
    );
  }
  const auth = new google.auth.JWT({
    email: config.google.serviceAccountEmail,
    key: config.google.privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Range handling
// ---------------------------------------------------------------------------
//
// Reading this stock tab is slow whatever we ask for - measured in production,
// open-ended "'Conferencia de estoque '!A:B" returned 7074 rows in 113s and the
// bounded "A1:B20000" took 281s for the same data. The time goes into the
// spreadsheet recalculating on read, not into the range, so bounding is opt-in:
// set GOOGLE_SHEET_MAX_ROWS to a row count to clamp an open-ended range.
const MAX_ROWS = Number(process.env.GOOGLE_SHEET_MAX_ROWS ?? "0") || 0;

/** "'Tab '!A:B" -> "'Tab '!A1:B<maxRows>", when clamping is enabled. Ranges
 *  that already carry row numbers are left untouched. */
export function boundRange(range: string, maxRows = MAX_ROWS): string {
  if (!maxRows) return range;
  return range.replace(/!\s*([A-Z]+):([A-Z]+)\s*$/i, (_m, a, b) => `!${a}1:${b}${maxRows}`);
}

// ---------------------------------------------------------------------------
// Cached read
// ---------------------------------------------------------------------------
//
// A single Asana action produces several webhook deliveries within seconds, and
// each Vercel instance would otherwise repeat the (slow) sheet read for every
// one. Rows are kept per range in module scope and served stale while a refresh
// runs in the background, so only the very first request on a cold instance
// ever waits for Google.
const FRESH_MS = Number(process.env.GOOGLE_SHEET_TTL_MS ?? "300000") || 300_000; // 5 min

type CacheEntry = { rows: string[][]; at: number };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string[][]>>();

async function fetchRows(range: string): Promise<string[][]> {
  const started = Date.now();
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    majorDimension: "ROWS",
    fields: "values",
  });
  const rows = (res.data.values as string[][]) ?? [];
  cache.set(range, { rows, at: Date.now() });
  console.log(`[sheets] read ${rows.length} row(s) from "${range}" in ${Date.now() - started}ms`);
  return rows;
}

function refresh(range: string): Promise<string[][]> {
  const existing = inFlight.get(range);
  if (existing) return existing;
  const promise = fetchRows(range).finally(() => {
    if (inFlight.get(range) === promise) inFlight.delete(range);
  });
  inFlight.set(range, promise);
  return promise;
}

/**
 * Read the stock rows ([serial, shelf]).
 *
 * @param force  bypass the cache and wait for a fresh read
 * @param rangeOverride  read a different A1 range (used by the backfill's
 *                       ?range= probe when tuning the sheet read)
 */
export async function readStockRows(
  force = false,
  rangeOverride?: string,
): Promise<string[][]> {
  if (!config.google.sheetId) {
    throw new Error("GOOGLE_SHEET_ID is not configured");
  }
  const range = boundRange(rangeOverride ?? config.google.sheetRange);

  if (force) return refresh(range);

  const entry = cache.get(range);
  if (entry) {
    // Stale-while-revalidate: never make a webhook wait on Google.
    if (Date.now() - entry.at >= FRESH_MS) {
      void refresh(range).catch((err) =>
        console.error(`[sheets] background refresh failed:`, err?.message ?? err),
      );
    }
    return entry.rows;
  }
  return refresh(range);
}

/**
 * Find the shelf for a serial by scanning bottom-to-top (last match wins),
 * matching the XLOOKUP search-mode -1 behaviour. Returns "" if not found
 * or if the serial is empty.
 */
export function lookupShelf(rows: string[][], serial: string): string {
  const target = normalizeSerial(serial);
  if (!target) return "";

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    if (normalizeSerial(row[0]) === target) {
      const shelf = row[1];
      return shelf === undefined || shelf === null ? "" : String(shelf);
    }
  }
  return "";
}
