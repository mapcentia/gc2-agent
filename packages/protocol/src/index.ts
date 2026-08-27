/** Wire protocol between @centia-io/agent-ui and @centia-io/agent-server. */

export type Role = "user" | "assistant";

/** Plain text history entry — the only message shape the client persists. */
export type TextMessage = { role: Role; content: string };

/** Host-app context injected into the system prompt. */
export type AppContext = {
  /** Host application id, e.g. "centia-app". */
  app: string;
  /** Optional free-text description of where the user is. */
  description?: string;
  /** Structured context: page, schema, activeLayers, ... */
  data?: Record<string, unknown>;
};

/** A tool call the model requested but the server has not executed yet. */
export type PendingToolRequest = {
  id: string;
  name: string;
  input: unknown;
  /** true = WRITE tool: needs an explicit user decision before execution. */
  requiresApproval: boolean;
};

export type ToolDecision = { toolUseId: string; approved: boolean };

/** Echo of a confirm_request plus the user's decisions. */
export type ResumePayload = {
  /** Opaque adapter state from the confirm_request event. Echo unchanged. */
  snapshot: unknown;
  pending: PendingToolRequest[];
  /** One decision per requiresApproval request. */
  decisions: ToolDecision[];
};

export type ChatRequest = {
  messages: TextMessage[];
  context?: AppContext;
  resume?: ResumePayload;
};

/** NDJSON events streamed from POST /api/chat. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "confirm_request"; pending: PendingToolRequest[]; snapshot: unknown }
  | { type: "done"; stopReason: string | null; iterations: number; truncated: boolean }
  | { type: "error"; error: string };
