import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import type { ChatRequest } from "@centia-io/agent-protocol";
import { verifyToken } from "./auth.js";
import { mcpExecutor, runAgentStream, type ExecuteFn } from "./chat.js";
import { READ_SKILL_TOOL, loadAgentDocs, resolveDocsRoot, skillReader } from "./docs.js";
import { McpPool } from "./mcpPool.js";
import { createAdapterFromEnv } from "./provider.js";
import {
  SYSTEM_PROMPT,
  renderAgentsBlock,
  renderContextBlock,
  renderSkillCatalog,
} from "./prompt.js";

const PORT = Number(process.env["PORT"] ?? 8790);
const adapter = createAdapterFromEnv(process.env);
const pool = new McpPool();
setInterval(() => void pool.reap(), 60_000).unref();

// Knowledge bundled with the MCP server (AGENTS.md + skill guides), loaded
// once at boot for prompt-cache stability. Missing docs are a warning, not
// an error — the agent still works, just without the guides.
const docsRoot = resolveDocsRoot(process.env);
const docs = await loadAgentDocs(docsRoot);
const readSkill = skillReader(docs);
if (!docsRoot) {
  console.warn("[boot] MCP docs not found (set MCP_DOCS_PATH); running without AGENTS.md/skills");
}

const staticSystemBlocks: string[] = [SYSTEM_PROMPT];
if (docs.agentsMd) staticSystemBlocks.push(renderAgentsBlock(docs.agentsMd));
if (docs.skills.length > 0) staticSystemBlocks.push(renderSkillCatalog(docs.skills));

const app = new Hono();
app.use("/api/*", cors());

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    provider: adapter.provider,
    model: adapter.model,
    sessions: pool.size(),
    docs: { agentsMd: docs.agentsMd !== null, skills: docs.skills.length },
  }),
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

  const systemBlocks = [...staticSystemBlocks];
  if (body.context) systemBlocks.push(renderContextBlock(body.context));

  c.header("Content-Type", "application/x-ndjson; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  const mcpExec = mcpExecutor(session);
  const execute: ExecuteFn = (req) =>
    req.name === READ_SKILL_TOOL.name ? readSkill(req) : mcpExec(req);

  return stream(c, async (s) => {
    const events = runAgentStream({
      adapter,
      systemBlocks,
      tools: [...session.tools, READ_SKILL_TOOL],
      messages: body.messages,
      resume: body.resume,
      execute,
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
