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
 * serial that simply isn't in the sheet is kept so it still gets its own
 * "SERIAL → ?" line in the output.
 */
export function splitSerials(value: unknown): string[] {
  return String(value ?? "")
    .split(/[\r\n,]+/)
    .map((entry) => entry.split(/\s[-–—]\s/)[0].trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Storage Shelf value
// ---------------------------------------------------------------------------

/** Asana rejects text custom-field values longer than this. */
export const ASANA_TEXT_FIELD_MAX_CHARS = 1024;

/** Between the serial and its shelf on each Storage Shelf line. */
export const SERIAL_SHELF_SEPARATOR = " → ";

/** Written in place of the shelf when a serial is not in the stock sheet. */
export const SHELF_NOT_FOUND_MARKER = "?";

/**
 * Build the Storage Shelf value for a task's serials.
 *
 * One line per serial, in input order, each carrying the serial AND its shelf,
 * so the field reads as a self-contained picking list and nobody has to scroll
 * back to the Serial Number field to pair them up:
 *
 *   SH9Y3YLC37W → A3
 *   C02XK1ABJG5H → ?      (serial not in the sheet)
 *
 * Rules:
 * - No serial matches at all → "" (unchanged: the webhook clears the field like
 *   the original XLOOKUP formula, and the backfill's non-destructive default
 *   leaves a hand-typed shelf alone).
 * - Asana caps text fields at ASANA_TEXT_FIELD_MAX_CHARS. If the serial+shelf
 *   form would exceed it, group the serials by shelf instead, one line per
 *   shelf in first-seen order, which keeps every serial paired with its shelf
 *   while writing each shelf only once:
 *
 *     SJVJJV6614L, SM199JRDWPG, SJ4LVWGMFC7 → K3
 *     SDYCD2D69WC, SL4CMWYR3F4 → K4
 *
 * - Only if even the grouped form is too long, fall back to the compact
 *   shelf-only list (the pre-2026-09-18 format) so a task with very many
 *   machines still gets its shelves instead of a rejected write.
 */
export function buildShelfFieldValue(rows: string[][], serials: string[]): string {
  const hits = serials.map((serial) => ({ serial, shelf: lookupShelf(rows, serial) }));
  if (!hits.some((h) => h.shelf !== "")) return "";

  const detailed = hits
    .map((h) => `${h.serial}${SERIAL_SHELF_SEPARATOR}${h.shelf || SHELF_NOT_FOUND_MARKER}`)
    .join("\n");
  if (detailed.length <= ASANA_TEXT_FIELD_MAX_CHARS) return detailed;

  const byShelf = new Map<string, string[]>();
  for (const h of hits) {
    const shelf = h.shelf.trim() || SHELF_NOT_FOUND_MARKER;
    const group = byShelf.get(shelf);
    if (group) group.push(h.serial);
    else byShelf.set(shelf, [h.serial]);
  }
  const grouped = Array.from(byShelf, ([shelf, group]) =>
    `${group.join(", ")}${SERIAL_SHELF_SEPARATOR}${shelf}`,
  ).join("\n");
  if (grouped.length <= ASANA_TEXT_FIELD_MAX_CHARS) return grouped;

  return hits.map((h) => h.shelf).join("\n");
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

// Configured range -> range that actually resolved against the spreadsheet,
// remembered per instance so a renamed tab costs one failed read, not one per
// request. See resolveRenamedTab().
const resolvedRanges = new Map<string, string>();

async function getValues(range: string): Promise<string[][]> {
  const res = await getSheetsClient().spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    majorDimension: "ROWS",
    fields: "values",
  });
  return (res.data.values as string[][]) ?? [];
}

/** Rows are cached under the CONFIGURED range so readStockRows keeps hitting
 *  the cache even when the read itself went to a resolved (renamed) tab. */
async function fetchRows(range: string): Promise<string[][]> {
  const started = Date.now();
  let effective = resolvedRanges.get(range) ?? range;
  let rows: string[][];
  try {
    rows = await getValues(effective);
  } catch (err) {
    if (!isUnknownRangeError(err)) throw err;
    effective = await resolveRenamedTab(range);
    resolvedRanges.set(range, effective);
    rows = await getValues(effective);
  }
  cache.set(range, { rows, at: Date.now() });
  console.log(`[sheets] read ${rows.length} row(s) from "${effective}" in ${Date.now() - started}ms`);
  return rows;
}

// ---------------------------------------------------------------------------
// Tab-name drift
// ---------------------------------------------------------------------------
//
// Google answers "Unable to parse range" when the tab in an A1 range does not
// exist. That is exactly what happened when someone tidied the stock tab's
// name from "Conferencia de estoque " (trailing space) to
// "Conferencia de estoque": every read failed, no shelf was written, and the
// only trace was an error-level log line. Cosmetic renames (whitespace, case,
// accents) are now absorbed by matching the configured tab against the real
// tab titles; anything else fails with the list of tabs that DO exist.

function isUnknownRangeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /unable to parse range/i.test(msg);
}

/** "'Tab '!A:B" -> { tab: "Tab ", cells: "A:B" }; "A:B" -> { tab: null, ... }. */
export function splitA1Range(range: string): { tab: string | null; cells: string } {
  const bang = range.lastIndexOf("!");
  if (bang === -1) return { tab: null, cells: range };
  const rawTab = range.slice(0, bang);
  const cells = range.slice(bang + 1);
  const quoted = rawTab.trim().match(/^'(.*)'$/);
  return { tab: quoted ? quoted[1].replace(/''/g, "'") : rawTab, cells };
}

/** Quote a tab title for A1 notation ("O'Brien" -> "'O''Brien'"). */
export function quoteTabTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Fold the differences a human rename usually introduces. */
export function normalizeTabTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // combining marks left by NFD (accents)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The one real tab title matching `wanted` (exact first, then normalized);
 *  null when nothing or more than one tab matches. */
export function matchTabTitle(wanted: string, titles: string[]): string | null {
  if (titles.includes(wanted)) return wanted;
  const target = normalizeTabTitle(wanted);
  const hits = titles.filter((t) => normalizeTabTitle(t) === target);
  return hits.length === 1 ? hits[0] : null;
}

async function resolveRenamedTab(range: string): Promise<string> {
  const { tab, cells } = splitA1Range(range);
  if (tab === null) throw new Error(`Unable to parse range: ${range}`);

  const meta = await getSheetsClient().spreadsheets.get({
    spreadsheetId: config.google.sheetId,
    fields: "sheets.properties.title",
  });
  const titles = (meta.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => typeof t === "string");

  const match = matchTabTitle(tab, titles);
  if (!match) {
    throw new Error(
      `Tab ${JSON.stringify(tab)} not found in the spreadsheet (range ${JSON.stringify(range)}). ` +
        `Existing tabs: ${titles.map((t) => JSON.stringify(t)).join(", ")}. ` +
        `Fix GOOGLE_SHEET_RANGE.`,
    );
  }
  const resolved = `${quoteTabTitle(match)}!${cells}`;
  console.warn(
    `[sheets] Tab ${JSON.stringify(tab)} no longer exists; reading ${JSON.stringify(resolved)} ` +
      `instead. Update GOOGLE_SHEET_RANGE to silence this.`,
  );
  return resolved;
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
