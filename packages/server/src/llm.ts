import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  FunctionTool,
  Response as OpenAIResponse,
} from "openai/resources/responses/responses";

export type LlmProvider = string;

export type IncomingMessage = { role: "user" | "assistant"; content: string };

export type ToolExecutionResult = {
  toolUseId: string;
  content: string;
  isError: boolean;
};

export type LlmEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

export type ToolRequest = {
  id: string;
  name: string;
  input: unknown;
};

export type ModelTurn = {
  textEvents: LlmEvent[];
  toolRequests: ToolRequest[];
  stopReason: string | null;
  rawResponse: unknown;
};

export type ParsedContent = {
  textEvents: LlmEvent[];
  toolRequests: ToolRequest[];
};

/**
 * Map Anthropic content blocks to stream events and executable tool requests.
 * server_tool_use blocks are surfaced as events only — the API already
 * executed them server-side, so they must never reach the chat loop's tool
 * executor.
 */
export const parseAnthropicContent = (
  content: readonly Anthropic.Beta.BetaContentBlock[],
): ParsedContent => {
  const textEvents: LlmEvent[] = [];
  const toolRequests: ToolRequest[] = [];
  for (const block of content) {
    if (block.type === "text") {
      textEvents.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      const request = { id: block.id, name: block.name, input: block.input };
      toolRequests.push(request);
      textEvents.push({ type: "tool_use", ...request });
    } else if (block.type === "server_tool_use") {
      textEvents.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
  }
  return { textEvents, toolRequests };
};

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  createInitialTurn(args: {
    systemBlocks: string[];
    tools: Anthropic.Tool[];
    messages: IncomingMessage[];
  }): Promise<ModelTurn>;
  createToolResultTurn(args: {
    previousResponse: unknown;
    systemBlocks: string[];
    tools: Anthropic.Tool[];
    toolResults: ToolExecutionResult[];
  }): Promise<ModelTurn>;
  isProviderError(err: unknown): { matched: boolean; status?: number };
}

const parseJsonObject = (raw: string): unknown => {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
};

const anthropicToolResult = (
  result: ToolExecutionResult,
): Anthropic.ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: result.toolUseId,
  content: result.content,
  is_error: result.isError,
});

const logAnthropicUsage = (usage: Anthropic.Messages.Usage): void => {
  console.log(
    `[anthropic cache] input=${usage.input_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} output=${usage.output_tokens}`,
  );
};

/** Minimal slice of the Anthropic client the adapter uses — injectable for
 * tests, and satisfied by both `Anthropic` and `AnthropicBedrockMantle`. */
export type AnthropicClientLike = {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
};

export class AnthropicAdapter implements LlmAdapter {
  readonly provider: string;
  readonly model: string;
  private readonly clientFactory: () => AnthropicClientLike;
  private client: AnthropicClientLike | null = null;

  constructor(
    model: string,
    opts?: { clientFactory?: () => AnthropicClientLike; provider?: string },
  ) {
    this.model = model;
    this.provider = opts?.provider ?? "anthropic";
    this.clientFactory =
      opts?.clientFactory ?? (() => new Anthropic() as AnthropicClientLike);
  }

  async createInitialTurn(args: {
    systemBlocks: string[];
    tools: Anthropic.Tool[];
    messages: IncomingMessage[];
  }): Promise<ModelTurn> {
    return this.createTurn({
      systemBlocks: args.systemBlocks,
      tools: args.tools,
      messages: args.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
  }

  async createToolResultTurn(args: {
    previousResponse: unknown;
    systemBlocks: string[];
    tools: Anthropic.Tool[];
    toolResults: ToolExecutionResult[];
  }): Promise<ModelTurn> {
    const messages = args.previousResponse as Anthropic.MessageParam[];
    messages.push({
      role: "user",
      content: args.toolResults.map(anthropicToolResult),
    });
    return this.createTurn({
      systemBlocks: args.systemBlocks,
      tools: args.tools,
      messages,
    });
  }

  isProviderError(err: unknown): { matched: boolean; status?: number } {
    if (err instanceof Anthropic.APIError) {
      return { matched: true, status: err.status };
    }
    return { matched: false };
  }

  private async createTurn(args: {
    systemBlocks: string[];
    tools: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
  }): Promise<ModelTurn> {
    const baseParams = {
      model: this.model,
      max_tokens: 16_384,
      thinking: { type: "adaptive" as const },
      output_config: { effort: "medium" as const },
      system: args.systemBlocks.map((text) => ({
        type: "text" as const,
        text,
        cache_control: { type: "ephemeral" as const },
      })),
    };

    const response = await this.getClient().messages.create({
      ...baseParams,
      tools: args.tools,
      messages: args.messages,
    });
    logAnthropicUsage(response.usage);
    args.messages.push({ role: "assistant", content: response.content });
    // Non-beta blocks are a structural subset of beta blocks except
    // ServerToolUseBlock.input (unknown vs object); the parser treats
    // input as unknown either way.
    const { textEvents, toolRequests } = parseAnthropicContent(
      response.content as readonly Anthropic.Beta.BetaContentBlock[],
    );
    return {
      textEvents,
      toolRequests,
      stopReason: response.stop_reason,
      rawResponse: args.messages,
    };
  }

  private getClient(): AnthropicClientLike {
    if (!this.client) this.client = this.clientFactory();
    return this.client;
  }
}

const toOpenAITools = (tools: Anthropic.Tool[]): FunctionTool[] =>
  tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description ?? `Tool: ${tool.name}`,
    parameters: tool.input_schema as Record<string, unknown>,
    strict: null,
  }));

export class OpenAIAdapter implements LlmAdapter {
  readonly provider = "openai" as const;
  readonly model: string;
  private readonly baseURL: string | undefined;
  private client: OpenAI | null = null;

  constructor(model: string, opts?: { baseURL?: string }) {
    this.model = model;
    this.baseURL = opts?.baseURL;
  }

  async createInitialTurn(args: {
    systemBlocks: string[];
    tools: Anthropic.Tool[];
    messages: IncomingMessage[];
  }): Promise<ModelTurn> {
    const response = await this.getClient().responses.create({
      model: this.model,
      stream: false,
      instructions: args.systemBlocks.join("\n\n"),
      max_output_tokens: 16_384,
      tools: toOpenAITools(args.tools),
      input: args.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
    return this.toTurn(response);
  }

  async createToolResultTurn(args: {
    previousResponse: unknown;
    systemBlocks: string[];
    tools: Anthropic.Tool[];
    toolResults: ToolExecutionResult[];
  }): Promise<ModelTurn> {
    const previous = args.previousResponse as OpenAIResponse;
    const response = await this.getClient().responses.create({
      model: this.model,
      stream: false,
      previous_response_id: previous.id,
      instructions: args.systemBlocks.join("\n\n"),
      max_output_tokens: 16_384,
      tools: toOpenAITools(args.tools),
      input: args.toolResults.map((r) => ({
        type: "function_call_output" as const,
        call_id: r.toolUseId,
        output: r.content,
      })),
    });
    return this.toTurn(response);
  }

  isProviderError(err: unknown): { matched: boolean; status?: number } {
    if (err instanceof OpenAI.APIError) {
      return { matched: true, status: err.status };
    }
    return { matched: false };
  }

  private toTurn(response: OpenAIResponse): ModelTurn {
    const u = response.usage;
    if (u) {
      console.log(
        `[openai cache] input=${u.input_tokens} cache_read=${u.input_tokens_details?.cached_tokens ?? 0} output=${u.output_tokens}`,
      );
    }

    const textEvents: LlmEvent[] = [];
    const toolRequests: ToolRequest[] = [];

    for (const item of response.output ?? []) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && part.text) {
            textEvents.push({ type: "text", text: part.text });
          }
        }
      } else if (item.type === "function_call") {
        const request = {
          id: item.call_id,
          name: item.name,
          input: parseJsonObject(item.arguments),
        };
        toolRequests.push(request);
        textEvents.push({ type: "tool_use", ...request });
      }
    }

    return {
      textEvents,
      toolRequests,
      stopReason: toolRequests.length > 0 ? "tool_use" : (response.status ?? null),
      rawResponse: response,
    };
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI(
        this.baseURL
          ? { baseURL: this.baseURL, apiKey: process.env["OPENAI_API_KEY"] ?? "local" }
          : {},
      );
    }
    return this.client;
  }
}
