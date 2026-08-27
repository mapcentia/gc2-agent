import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import { filterExposedTools } from "./guardrails.js";

const MAX_RESULT_CHARS = 200_000;

export type McpSession = {
  tools: Anthropic.Tool[];
  callTool(name: string, input: unknown): Promise<{ content: string; isError: boolean }>;
  close(): Promise<void>;
};

export type SessionFactory = (token: string) => Promise<McpSession>;

const truncate = (s: string): string =>
  s.length <= MAX_RESULT_CHARS
    ? s
    : s.slice(0, MAX_RESULT_CHARS) +
      `\n…[truncated ${s.length - MAX_RESULT_CHARS} chars of ${s.length} total. ` +
      "Add LIMIT/OFFSET, narrow the query, or paginate to see more.]";

/**
 * Spawn the Centia MCP server as a stdio child with the user's token in its
 * env (API_TOKEN is how today's mcp-server receives auth). One process per
 * distinct token; the pool below bounds and reaps them.
 */
export const stdioSessionFactory: SessionFactory = async (token) => {
  const command = process.env["MCP_COMMAND"] ?? "node";
  const argsRaw = process.env["MCP_ARGS"];
  if (!argsRaw) throw new Error("Missing required env var: MCP_ARGS");
  const args = argsRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      ...(process.env["PATH"] ? { PATH: process.env["PATH"] } : {}),
      API_TOKEN: token,
      API_BASE_URL: process.env["API_BASE_URL"] ?? "https://api.centia.io",
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "centia-agent", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const exposed = filterExposedTools(tools).map(
    (t): Anthropic.Tool => ({
      name: t.name,
      description: t.description ?? `Centia MCP tool: ${t.name}`,
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    }),
  );

  return {
    tools: exposed,
    callTool: async (name, input) => {
      const args2 =
        typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
      const result = await client.callTool({ name, arguments: args2 });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((b) =>
          typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text"
            ? String((b as { text?: unknown }).text ?? "")
            : JSON.stringify(b),
        )
        .join("\n");
      return { content: truncate(text), isError: result.isError === true };
    },
    close: async () => {
      await client.close();
    },
  };
};

type Entry = { session: McpSession; lastUsed: number };

export class McpPool {
  private readonly factory: SessionFactory;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Promise<Entry>>();

  constructor(opts?: {
    factory?: SessionFactory;
    ttlMs?: number;
    maxSessions?: number;
    now?: () => number;
  }) {
    this.factory = opts?.factory ?? stdioSessionFactory;
    this.ttlMs = opts?.ttlMs ?? 10 * 60_000;
    this.maxSessions = opts?.maxSessions ?? 20;
    this.now = opts?.now ?? Date.now;
  }

  size(): number {
    return this.entries.size;
  }

  async acquire(token: string): Promise<McpSession> {
    const key = createHash("sha256").update(token).digest("hex");
    const existing = this.entries.get(key);
    if (existing) {
      const entry = await existing;
      entry.lastUsed = this.now();
      return entry.session;
    }
    const created = this.factory(token).then((session) => ({
      session,
      lastUsed: this.now(),
    }));
    // Cache the promise so concurrent requests share one spawn; drop on failure.
    this.entries.set(key, created);
    let entry: Entry;
    try {
      entry = await created;
    } catch (err) {
      this.entries.delete(key);
      throw err;
    }
    await this.evictOverflow(key);
    return entry.session;
  }

  private async evictOverflow(keep: string): Promise<void> {
    while (this.entries.size > this.maxSessions) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, p] of this.entries) {
        if (k === keep) continue;
        const e = await p.catch(() => null);
        if (e && e.lastUsed < oldest) {
          oldest = e.lastUsed;
          oldestKey = k;
        }
      }
      if (!oldestKey) return;
      await this.closeEntry(oldestKey);
    }
  }

  async reap(): Promise<void> {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, p] of [...this.entries]) {
      const e = await p.catch(() => null);
      if (!e) {
        this.entries.delete(k);
      } else if (e.lastUsed <= cutoff) {
        await this.closeEntry(k);
      }
    }
  }

  private async closeEntry(key: string): Promise<void> {
    const p = this.entries.get(key);
    this.entries.delete(key);
    const e = await p?.catch(() => null);
    await e?.session.close().catch(() => undefined);
  }
}
