/**
 * Tool classification for the agent's guardrails.
 *
 * read  — auto-executed (inspection + read-only SQL).
 * write — provisioning/mutation: requires an explicit per-call user
 *         confirmation in the chat UI before execution.
 * deny  — never exposed to the model. Auth/account management stays in
 *         the regular UI; postSqlNoToken bypasses the user's token.
 *
 * Unknown names default to deny so new MCP tools fail closed until
 * classified here.
 */

const DENY = new Set([
  "postOauth",
  "postDevice",
  "postClient",
  "patchClient",
  "deleteClient",
  "postUser",
  "patchUser",
  "deleteUsers",
  "postSqlNoToken",
]);

// Only postSql is auto-read (guarded by isReadOnlySql).
// postGraphQL and postCallDry deliberately fall through to "write" because
// there is no payload guard for GraphQL mutations and dry-run side effects.
const READ_EXTRA = new Set(["postSql"]);

export type ToolClass = "read" | "write" | "deny";

export const classifyTool = (name: string): ToolClass => {
  if (DENY.has(name)) return "deny";
  if (name.startsWith("get") || READ_EXTRA.has(name)) return "read";
  if (/^(post|patch|delete)[A-Z]/.test(name)) return "write";
  return "deny";
};

/** SELECT / WITH / EXPLAIN / SHOW after leading comments and whitespace. */
const SQL_READ_ONLY =
  /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(select|with|explain|show)\b/i;

export const isReadOnlySql = (q: unknown): boolean =>
  typeof q === "string" && SQL_READ_ONLY.test(q);

/** Tools shown to the model: deny removed, sorted for prompt-cache stability. */
export const filterExposedTools = <T extends { name: string }>(tools: T[]): T[] =>
  tools
    .filter((t) => classifyTool(t.name) !== "deny")
    .sort((a, b) => a.name.localeCompare(b.name));
