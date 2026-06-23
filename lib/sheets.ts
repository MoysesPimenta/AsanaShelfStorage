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

/** Read the configured range once. Returns rows of [serial, shelf]. */
export async function readStockRows(): Promise<string[][]> {
  if (!config.google.sheetId) {
    throw new Error("GOOGLE_SHEET_ID is not configured");
  }
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: config.google.sheetRange,
    valueRenderOption: "UNFORMATTED_VALUE",
    majorDimension: "ROWS",
  });
  return (res.data.values as string[][]) ?? [];
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
