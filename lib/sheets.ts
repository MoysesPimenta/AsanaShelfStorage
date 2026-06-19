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
