import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentEvent,
  PendingToolRequest,
  ResumePayload,
} from "@centia-io/agent-protocol";
import { classifyTool, isReadOnlySql } from "./guardrails.js";
import type {
  IncomingMessage,
  LlmAdapter,
  ToolExecutionResult,
  ToolRequest,
} from "./llm.js";
import type { McpSession } from "./mcpPool.js";

export const MAX_ITERATIONS = 20;

export type ExecuteFn = (req: ToolRequest) => Promise<ToolExecutionResult>;

/** Tool executor bound to one user's MCP session, enforcing guardrails. */
export const mcpExecutor =
  (session: McpSession): ExecuteFn =>
  async (req) => {
    if (classifyTool(req.name) === "deny") {
      return {
        toolUseId: req.id,
        content: JSON.stringify({ error: `Tool not available: ${req.name}` }),
        isError: true,
      };
    }
    if (req.name === "postSql") {
      const q = (req.input as { q?: unknown } | undefined)?.q;
      if (!isReadOnlySql(q)) {
        return {
          toolUseId: req.id,
          content: JSON.stringify({
            error:
              "postSql accepts only SELECT, WITH, EXPLAIN, or SHOW. Use the typed provisioning tools for writes.",
          }),
          isError: true,
        };
      }
    }
    try {
      const { content, isError } = await session.callTool(req.name, req.input);
      return { toolUseId: req.id, content, isError };
    } catch (err) {
      return {
        toolUseId: req.id,
        content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }
  };

const DENIED_RESULT = JSON.stringify({
  denied: true,
  message:
    "The user declined this operation. Do not retry it. Summarize the situation and ask the user how to proceed if needed.",
});

const toPending = (requests: ToolRequest[]): PendingToolRequest[] =>
  requests.map((r) => ({ ...r, requiresApproval: classifyTool(r.name) === "write" }));

/**
 * The agentic loop. Reads auto-execute; a turn containing any write tool
 * executes NOTHING — it emits confirm_request (all pending requests + the
 * adapter's opaque snapshot) and ends with stopReason "awaiting_confirmation".
 * The client re-POSTs with `resume` and the loop picks up from the snapshot.
 * All guardrail decisions are re-derived server-side on resume — the client's
 * requiresApproval flags are advisory only.
 */
export async function* runAgentStream(deps: {
  adapter: LlmAdapter;
  systemBlocks: string[];
  tools: Anthropic.Tool[];
  messages: IncomingMessage[];
  resume?: ResumePayload;
  execute: ExecuteFn;
  maxIterations?: number;
}): AsyncGenerator<AgentEvent> {
  const maxIterations = deps.maxIterations ?? MAX_ITERATIONS;
  let iteration = 0;
  let lastStopReason: string | null = null;
  let previousResponse: unknown = null;
  let pendingToolResults: ToolExecutionResult[] = [];

  const runRequests = async function* (
    requests: PendingToolRequest[],
    approvals: Map<string, boolean>,
  ): AsyncGenerator<AgentEvent> {
    pendingToolResults = [];
    for (const req of requests) {
      const cls = classifyTool(req.name);
      let result: ToolExecutionResult;
      if (cls === "deny") {
        result = {
          toolUseId: req.id,
          content: JSON.stringify({ error: `Tool not available: ${req.name}` }),
          isError: true,
        };
      } else if (cls === "write" && approvals.get(req.id) !== true) {
        result = { toolUseId: req.id, content: DENIED_RESULT, isError: false };
      } else {
        result = await deps.execute(req);
      }
      yield { type: "tool_result", toolUseId: result.toolUseId, content: result.content, isError: result.isError };
      pendingToolResults.push(result);
    }
  };

  if (deps.resume) {
    const approvals = new Map(
      deps.resume.decisions.map((d) => [d.toolUseId, d.approved] as const),
    );
    yield* runRequests(toPending(deps.resume.pending.map(({ id, name, input }) => ({ id, name, input }))), approvals);
    previousResponse = deps.resume.snapshot;
  }

  while (iteration < maxIterations) {
    iteration++;
    const turn =
      previousResponse === null
        ? await deps.adapter.createInitialTurn({
            systemBlocks: deps.systemBlocks,
            tools: deps.tools,
            messages: deps.messages,
          })
        : await deps.adapter.createToolResultTurn({
            previousResponse,
            systemBlocks: deps.systemBlocks,
            tools: deps.tools,
            toolResults: pendingToolResults,
          });

    previousResponse = turn.rawResponse;
    lastStopReason = turn.stopReason;

    for (const ev of turn.textEvents) yield ev as AgentEvent;

    if (turn.toolRequests.length === 0) break;

    const pending = toPending(turn.toolRequests);
    if (pending.some((p) => p.requiresApproval)) {
      yield { type: "confirm_request", pending, snapshot: turn.rawResponse };
      lastStopReason = "awaiting_confirmation";
      break;
    }

    yield* runRequests(pending, new Map());
  }

  yield {
    type: "done",
    stopReason: lastStopReason,
    iterations: iteration,
    truncated: iteration >= maxIterations && lastStopReason === "tool_use",
  };
}
