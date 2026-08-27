import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicAdapter, parseAnthropicContent } from "../src/llm.js";
import { createAdapterFromEnv } from "../src/provider.js";

test("parseAnthropicContent maps text and tool_use", () => {
  const content = [
    { type: "text", text: "hello" },
    { type: "tool_use", id: "t1", name: "getSchema", input: { namesOnly: true } },
  ] as unknown as readonly Anthropic.Beta.BetaContentBlock[];
  const parsed = parseAnthropicContent(content);
  assert.equal(parsed.textEvents.length, 2);
  assert.deepEqual(parsed.toolRequests, [
    { id: "t1", name: "getSchema", input: { namesOnly: true } },
  ]);
});

test("factory defaults to bedrock and requires AWS_REGION", () => {
  assert.throws(() => createAdapterFromEnv({}), /AWS_REGION/);
  const adapter = createAdapterFromEnv({ AWS_REGION: "eu-central-1" });
  assert.equal(adapter.provider, "bedrock");
  assert.equal(adapter.model, "anthropic.claude-opus-5");
});

test("factory selects anthropic and openai", () => {
  assert.equal(createAdapterFromEnv({ LLM_PROVIDER: "anthropic" }).provider, "anthropic");
  const local = createAdapterFromEnv({
    LLM_PROVIDER: "openai",
    OPENAI_MODEL: "llama3",
    OPENAI_BASE_URL: "http://localhost:11434/v1",
  });
  assert.equal(local.provider, "openai");
  assert.equal(local.model, "llama3");
  assert.throws(() => createAdapterFromEnv({ LLM_PROVIDER: "nope" }), /Invalid LLM_PROVIDER/);
});

test("AnthropicAdapter turn round-trip with injected fake client", async () => {
  const fake = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming) {
        return {
          content: [
            { type: "text", text: `saw ${params.messages.length} messages` },
            { type: "tool_use", id: "t1", name: "getTable", input: { schema: "s" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
      },
    },
  };
  const adapter = new AnthropicAdapter("m", { clientFactory: () => fake });
  const turn = await adapter.createInitialTurn({
    systemBlocks: ["sys"],
    tools: [],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(turn.stopReason, "tool_use");
  assert.equal(turn.toolRequests.length, 1);
  // rawResponse is the running MessageParam[] incl. the assistant turn
  const history = turn.rawResponse as Anthropic.MessageParam[];
  assert.equal(history.length, 2);
  assert.equal(history[1]?.role, "assistant");
});
