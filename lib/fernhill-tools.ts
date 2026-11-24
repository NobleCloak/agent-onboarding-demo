// What marks a tool as Fernhill's, shared by the proxy (server) and the Permissions page (browser).

export const OURS = "ext:fernhill-desk:";

/** Whether a `GET /v1/tools` answer lists any of Fernhill's tools. False for anything that is not such a list. */
export function hasFernhillTools(body: unknown): boolean {
  const rows = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  return Array.isArray(rows) && rows.some((t) => typeof t?.tool_ref === "string" && t.tool_ref.startsWith(OURS));
}
