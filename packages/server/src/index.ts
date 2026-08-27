import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import type { ChatRequest } from "@centia-io/agent-protocol";
import { verifyToken } from "./auth.js";
import { mcpExecutor, runAgentStream } from "./chat.js";
import { McpPool } from "./mcpPool.js";
import { createAdapterFromEnv } from "./provider.js";
import { SYSTEM_PROMPT, renderContextBlock } from "./prompt.js";

const PORT = Number(process.env["PORT"] ?? 8790);
const adapter = createAdapterFromEnv(process.env);
const pool = new McpPool();
setInterval(() => void pool.reap(), 60_000).unref();

const app = new Hono();
app.use("/api/*", cors());

app.get("/api/health", (c) =>
  c.json({ ok: true, provider: adapter.provider, model: adapter.model, sessions: pool.size() }),
);

const bearer = (auth: string | undefined): string | null => {
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

app.post("/api/chat", async (c) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: "Missing Authorization: Bearer token" }, 401);

  let body: ChatRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "Missing 'messages' array" }, 400);
  }

  if (!(await verifyToken(token))) {
    return c.json({ error: "Invalid or expired Centia token" }, 401);
  }

  let session;
  try {
    session = await pool.acquire(token);
  } catch (err) {
    return c.json(
      { error: `MCP unavailable: ${err instanceof Error ? err.message : String(err)}` },
      503,
    );
  }

  const systemBlocks = [SYSTEM_PROMPT];
  if (body.context) systemBlocks.push(renderContextBlock(body.context));

  c.header("Content-Type", "application/x-ndjson; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  return stream(c, async (s) => {
    const events = runAgentStream({
      adapter,
      systemBlocks,
      tools: session.tools,
      messages: body.messages,
      resume: body.resume,
      execute: mcpExecutor(session),
    });
    try {
      for await (const ev of events) {
        await s.write(`${JSON.stringify(ev)}\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await s.write(`${JSON.stringify({ type: "error", error: message })}\n`);
    }
  });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`centia-agent server on http://localhost:${info.port}`);
  console.log(`provider=${adapter.provider} model=${adapter.model}`);
  console.log(`mcp: ${process.env["MCP_COMMAND"] ?? "node"} ${process.env["MCP_ARGS"] ?? "(MCP_ARGS not set!)"}`);
});
