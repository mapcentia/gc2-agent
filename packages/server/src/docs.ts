import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolExecutionResult, ToolRequest } from "./llm.js";

/**
 * Knowledge shipped with the Centia MCP server: AGENTS.md (core rules) and
 * skills/<name>/SKILL.md guides. Injected into the agent so it follows the
 * same conventions as the coding agents (payload formats, id round-trips,
 * privileges, ...). AGENTS.md becomes a system block; skills are loaded on
 * demand through the local readSkill tool to keep the prompt small.
 */

export type SkillEntry = { name: string; description: string; body: string };
export type AgentDocs = { agentsMd: string | null; skills: SkillEntry[] };

/**
 * Locate the mcp-server checkout or installed package:
 * 1. MCP_DOCS_PATH env (explicit override; dev points it at the repo)
 * 2. derived from MCP_ARGS — the served dist/index.js lives one level below
 *    the package root in both the repo and the published package.
 * Returns null when nothing resolves; the agent then runs without the docs.
 */
export const resolveDocsRoot = (
  env: Record<string, string | undefined>,
): string | null => {
  const explicit = env["MCP_DOCS_PATH"]?.trim();
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null;

  const argsRaw = env["MCP_ARGS"] ?? "";
  const entry = argsRaw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .find((s) => s.endsWith(".js"));
  if (entry) {
    let dir = dirname(resolve(entry));
    for (let i = 0; i < 3; i++) {
      if (existsSync(join(dir, "AGENTS.md")) || existsSync(join(dir, "skills"))) {
        return dir;
      }
      dir = dirname(dir);
    }
  }
  return null;
};

const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

const parseFrontmatter = (text: string): { name: string; description: string } | null => {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!] = kv[2]!.trim();
  }
  const name = fields["name"];
  const description = fields["description"];
  return name && description ? { name, description } : null;
};

export const loadAgentDocs = async (root: string | null): Promise<AgentDocs> => {
  if (!root) return { agentsMd: null, skills: [] };

  let agentsMd: string | null = null;
  try {
    agentsMd = await readFile(join(root, "AGENTS.md"), "utf8");
  } catch {
    agentsMd = null;
  }

  const skills: SkillEntry[] = [];
  try {
    const entries = await readdir(join(root, "skills"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let body: string;
      try {
        body = await readFile(join(root, "skills", entry.name, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const meta = parseFrontmatter(body);
      if (!meta) continue; // no frontmatter — cannot catalog it
      skills.push({ name: meta.name, description: meta.description, body });
    }
  } catch {
    // no skills directory
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { agentsMd, skills };
};

export const READ_SKILL_TOOL: Anthropic.Tool = {
  name: "readSkill",
  description:
    "Load the full text of a Centia skill guide by name. The available skills and what they cover are listed in the system prompt. Read the relevant skill BEFORE using its tools (e.g. centia-map-styling before editing classes/styles/labels).",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Exact skill name from the catalog." },
    },
    required: ["name"],
  },
};

/** Executor for the local readSkill tool. Names validate against the catalog
 * (exact match) — unknown or path-shaped input fails closed. */
export const skillReader =
  (docs: AgentDocs) =>
  async (req: ToolRequest): Promise<ToolExecutionResult> => {
    const name = (req.input as { name?: unknown } | undefined)?.name;
    const skill =
      typeof name === "string" ? docs.skills.find((s) => s.name === name) : undefined;
    if (!skill) {
      return {
        toolUseId: req.id,
        content: JSON.stringify({
          error: `Unknown skill: ${String(name)}. Available: ${docs.skills.map((s) => s.name).join(", ")}`,
        }),
        isError: true,
      };
    }
    return { toolUseId: req.id, content: skill.body, isError: false };
  };
