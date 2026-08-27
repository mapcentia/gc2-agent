import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "@centia-io/agent-protocol";
import { runAgentStream } from "../src/chat.js";
import type { LlmAdapter, ModelTurn, ToolRequest } from "../src/llm.js";

/** Adapter that replays scripted turns. */
const scripted = (turns: ModelTurn[]): LlmAdapter => {
  let i = 0;
  return {
    provider: "fake",
    model: "fake",
    createInitialTurn: async () => turns[i++]!,
    createToolResultTurn: async () => turns[i++]!,
    isProviderError: () => ({ matched: false }),
  };
};

const turn = (
  toolRequests: ToolRequest[],
  stopReason = toolRequests.length ? "tool_use" : "end_turn",
): ModelTurn => ({
  textEvents: toolRequests.map((r) => ({ type: "tool_use" as const, ...r })),
  toolRequests,
  stopReason,
  rawResponse: { marker: "snapshot" },
});

const collect = async (gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

const base = {
  systemBlocks: ["sys"],
  tools: [] as Anthropic.Tool[],
  messages: [{ role: "user" as const, content: "hi" }],
};

test("read tools execute automatically", async () => {
  const executed: string[] = [];
  const events = await collect(
    runAgentStream({
      ...base,
      adapter: scripted([turn([{ id: "r1", name: "getSchema", input: {} }]), turn([])]),
      execute: async (req) => {
        executed.push(req.name);
        return { toolUseId: req.id, content: "{}", isError: false };
      },
    }),
  );
  assert.deepEqual(executed, ["getSchema"]);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 1);
  assert.equal(events.at(-1)?.type, "done");
});

test("a write tool pauses the loop with confirm_request", async () => {
  const executed: string[] = [];
  const events = await collect(
    runAgentStream({
      ...base,
      adapter: scripted([
        turn([
          { id: "w1", name: "postSchema", input: { name: "x" } },
          { id: "r1", name: "getTable", input: {} },
        ]),
      ]),
      execute: async (req) => {
        executed.push(req.name);
        return { toolUseId: req.id, content: "{}", isError: false };
      },
    }),
  );
  assert.deepEqual(executed, []); // nothing runs before confirmation
  const confirm = events.find((e) => e.type === "confirm_request");
  assert.ok(confirm && confirm.type === "confirm_request");
  assert.deepEqual(
    confirm.pending.map((p) => [p.name, p.requiresApproval]),
    [["postSchema", true], ["getTable", false]],
  );
  assert.deepEqual(confirm.snapshot, { marker: "snapshot" });
  const done = events.at(-1);
  assert.ok(done?.type === "done" && done.stopReason === "awaiting_confirmation");
});

test("resume executes approved writes and reads, denies the rest", async () => {
  const executed: string[] = [];
  const events = await collect(
    runAgentStream({
      ...base,
      adapter: scripted([turn([])]), // one final model turn after tool results
      resume: {
        snapshot: { marker: "snapshot" },
        pending: [
          { id: "w1", name: "postSchema", input: {}, requiresApproval: true },
          { id: "w2", name: "deleteTable", input: {}, requiresApproval: true },
          { id: "r1", name: "getTable", input: {}, requiresApproval: false },
        ],
        decisions: [
          { toolUseId: "w1", approved: true },
          { toolUseId: "w2", approved: false },
        ],
      },
      execute: async (req) => {
        executed.push(req.name);
        return { toolUseId: req.id, content: "{}", isError: false };
      },
    }),
  );
  assert.deepEqual(executed.sort(), ["getTable", "postSchema"]);
  const denied = events.find(
    (e) => e.type === "tool_result" && e.toolUseId === "w2",
  );
  assert.ok(denied && denied.type === "tool_result");
  assert.match(denied.content, /declined/);
  assert.equal(events.at(-1)?.type, "done");
});

test("resume re-classifies server-side: a deny tool never executes", async () => {
  const executed: string[] = [];
  const events = await collect(
    runAgentStream({
      ...base,
      adapter: scripted([turn([])]),
      resume: {
        snapshot: {},
        // client claims it needs no approval — server must not trust it
        pending: [{ id: "x1", name: "deleteUsers", input: {}, requiresApproval: false }],
        decisions: [],
      },
      execute: async (req) => {
        executed.push(req.name);
        return { toolUseId: req.id, content: "{}", isError: false };
      },
    }),
  );
  assert.deepEqual(executed, []);
  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result" && result.isError);
});

test("stops at maxIterations with truncated done", async () => {
  const loop = turn([{ id: "r1", name: "getSchema", input: {} }]);
  const events = await collect(
    runAgentStream({
      ...base,
      adapter: scripted([loop, { ...loop }, { ...loop }]),
      maxIterations: 3,
      execute: async (req) => ({ toolUseId: req.id, content: "{}", isError: false }),
    }),
  );
  const done = events.at(-1);
  assert.ok(done?.type === "done" && done.truncated === true);
});
