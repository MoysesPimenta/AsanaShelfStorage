// Centralized environment / configuration access.
// Defaults are provided for the non-secret Asana identifiers so the service
// works out of the box, but every value can be overridden via env vars.

export const config = {
  asana: {
    pat: process.env.ASANA_PAT ?? "",
    projectGid: process.env.ASANA_PROJECT_GID ?? "1209435989338394",
    workspaceGid: process.env.ASANA_WORKSPACE_GID ?? "1209435871242085",
    serialFieldGid: process.env.ASANA_SERIAL_CUSTOM_FIELD_GID ?? "1209458789411568",
    shelfFieldGid: process.env.ASANA_SHELF_CUSTOM_FIELD_GID ?? "1215845672985246",
    webhookSecret: process.env.ASANA_WEBHOOK_SECRET ?? "",
  },
  google: {
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "",
    // Private keys are often stored with escaped "\n"; convert to real newlines.
    privateKey: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    sheetId: process.env.GOOGLE_SHEET_ID ?? "",
    // IMPORTANT: the source tab name currently has a TRAILING SPACE after
    // "estoque". Preserve it unless the tab has been renamed.
    sheetRange: process.env.GOOGLE_SHEET_RANGE ?? "Conferencia de estoque !A:B",
  },
} as const;

export const ASANA_API_BASE = "https://app.asana.com/api/1.0";
