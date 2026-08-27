import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicAdapter,
  OpenAIAdapter,
  type AnthropicClientLike,
  type LlmAdapter,
} from "./llm.js";

const DEFAULT_BEDROCK_MODEL = "anthropic.claude-opus-5";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
const DEFAULT_OPENAI_MODEL = "gpt-5.1";

/**
 * Provider selection:
 *   bedrock (default) — AnthropicBedrockMantle, creds via the standard AWS
 *                        chain (env/profile/IAM role), AWS_REGION required.
 *   anthropic         — direct API (ANTHROPIC_API_KEY), for development.
 *   openai            — OpenAI-compatible endpoint; set OPENAI_BASE_URL to
 *                        point at Ollama / LM Studio / vLLM.
 */
export const createAdapterFromEnv = (
  env: Record<string, string | undefined>,
): LlmAdapter => {
  const provider = env["LLM_PROVIDER"]?.trim() || "bedrock";
  if (provider === "bedrock") {
    const region = env["AWS_REGION"];
    if (!region) throw new Error("LLM_PROVIDER=bedrock requires AWS_REGION");
    const model = env["BEDROCK_MODEL"]?.trim() || DEFAULT_BEDROCK_MODEL;
    return new AnthropicAdapter(model, {
      provider: "bedrock",
      clientFactory: () =>
        new AnthropicBedrockMantle({ awsRegion: region }) as unknown as AnthropicClientLike,
    });
  }
  if (provider === "anthropic") {
    const model = env["ANTHROPIC_MODEL"]?.trim() || DEFAULT_ANTHROPIC_MODEL;
    return new AnthropicAdapter(model, {
      clientFactory: () => new Anthropic() as AnthropicClientLike,
    });
  }
  if (provider === "openai") {
    const model = env["OPENAI_MODEL"]?.trim() || DEFAULT_OPENAI_MODEL;
    return new OpenAIAdapter(model, { baseURL: env["OPENAI_BASE_URL"]?.trim() || undefined });
  }
  throw new Error(`Invalid LLM_PROVIDER "${provider}". Expected bedrock | anthropic | openai.`);
};
