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

/** Leading comments/whitespace, stripped before classification. */
const LEADING_TRIVIA = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/;

/** SELECT / WITH / EXPLAIN / SHOW after leading comments and whitespace. */
const SQL_READ_ONLY_KEYWORD = /^(select|with|explain|show)\b/i;

/**
 * `EXPLAIN` followed by either the bare `ANALYZE` keyword or a parenthesized
 * options list that contains `ANALYZE` (e.g. `EXPLAIN (ANALYZE, BUFFERS)`).
 * EXPLAIN ANALYZE actually executes the statement, so it is not read-only.
 */
const EXPLAIN_ANALYZE =
  /^explain\s+(?:\(([^)]*)\)\s*|(analyze)\b)/i;

/** Write keywords anywhere in the statement, matched as whole words. */
const WRITE_KEYWORD =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|call|do|into)\b/i;

export const isReadOnlySql = (q: unknown): boolean => {
  if (typeof q !== "string") return false;

  // Strip leading comments/whitespace.
  let body = q.replace(LEADING_TRIVIA, "");

  // Strip exactly one trailing semicolon (with optional trailing
  // whitespace/comments after it), then reject if any `;` remains —
  // a cheap multi-statement guard. A `;` inside a string literal is a
  // rare false positive we accept; this fails safe.
  const trailingTrivia = /(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*$/;
  const trailingMatch = body.match(trailingTrivia);
  const trailingLen = trailingMatch ? trailingMatch[0].length : 0;
  const core = trailingLen > 0 ? body.slice(0, body.length - trailingLen) : body;
  if (core.endsWith(";")) {
    body = core.slice(0, -1);
  } else {
    body = core;
  }
  if (body.includes(";")) return false;

  if (!SQL_READ_ONLY_KEYWORD.test(body)) return false;

  const explainMatch = body.match(EXPLAIN_ANALYZE);
  if (explainMatch) {
    const options = explainMatch[1];
    const bareAnalyze = explainMatch[2];
    if (bareAnalyze || (options && /\banalyze\b/i.test(options))) {
      return false;
    }
  }

  if (WRITE_KEYWORD.test(body)) return false;

  return true;
};

/** Tools shown to the model: deny removed, sorted for prompt-cache stability. */
export const filterExposedTools = <T extends { name: string }>(tools: T[]): T[] =>
  tools
    .filter((t) => classifyTool(t.name) !== "deny")
    .sort((a, b) => a.name.localeCompare(b.name));
