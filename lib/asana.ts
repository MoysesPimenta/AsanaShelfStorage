// Asana API helpers. Uses native fetch (Node 18+). No secrets are logged.

import { ASANA_API_BASE, config } from "./config";

export interface AsanaCustomField {
  gid: string;
  name?: string;
  display_value?: string | null;
  text_value?: string | null;
  number_value?: number | null;
  enum_value?: { name?: string | null } | null;
}

export interface AsanaTask {
  gid: string;
  name?: string;
  custom_fields?: AsanaCustomField[];
}

const TASK_OPT_FIELDS = [
  "name",
  "custom_fields.gid",
  "custom_fields.name",
  "custom_fields.display_value",
  "custom_fields.text_value",
  "custom_fields.number_value",
  "custom_fields.enum_value.name",
].join(",");

function authHeaders(): Record<string, string> {
  if (!config.asana.pat) {
    throw new Error("ASANA_PAT is not configured");
  }
  return {
    Authorization: `Bearer ${config.asana.pat}`,
    Accept: "application/json",
  };
}

/**
 * Extract unique task GIDs from an Asana webhook events payload.
 * A project-scoped webhook with "task added"/"task changed" filters delivers
 * events whose `resource` is the task. We also defensively look at `parent`.
 */
export function extractTaskGids(events: unknown): string[] {
  const gids = new Set<string>();
  if (!Array.isArray(events)) return [];

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as Record<string, any>;

    const resource = e.resource;
    if (resource && typeof resource === "object") {
      if (resource.resource_type === "task" && typeof resource.gid === "string") {
        gids.add(resource.gid);
      }
    }
    const parent = e.parent;
    if (parent && typeof parent === "object") {
      if (parent.resource_type === "task" && typeof parent.gid === "string") {
        gids.add(parent.gid);
      }
    }
  }
  return [...gids];
}

/** Read a single task with the custom fields we care about. */
export async function getTask(taskGid: string): Promise<AsanaTask> {
  const url = `${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}?opt_fields=${encodeURIComponent(
    TASK_OPT_FIELDS,
  )}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Asana GET task ${taskGid} failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { data: AsanaTask };
  return json.data;
}

/** Find a custom field on a task by its GID. */
export function findCustomField(
  task: AsanaTask,
  fieldGid: string,
): AsanaCustomField | undefined {
  return task.custom_fields?.find((f) => f.gid === fieldGid);
}

/** Read the string value of a (text-type) custom field. */
export function readTextFieldValue(field: AsanaCustomField | undefined): string {
  if (!field) return "";
  if (typeof field.text_value === "string") return field.text_value;
  if (typeof field.display_value === "string") return field.display_value;
  if (typeof field.number_value === "number") return String(field.number_value);
  if (field.enum_value && typeof field.enum_value.name === "string") {
    return field.enum_value.name;
  }
  return "";
}

/**
 * Update a single text custom field on a task.
 * Passing an empty string clears the field (matches XLOOKUP "" default).
 */
export async function updateTaskCustomField(
  taskGid: string,
  fieldGid: string,
  value: string,
): Promise<void> {
  const url = `${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        custom_fields: {
          [fieldGid]: value,
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Asana PUT task ${taskGid} failed: ${res.status} ${body}`);
  }
}
