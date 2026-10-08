import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadAgentDocs,
  resolveDocsRoot,
  skillReader,
  READ_SKILL_TOOL,
} from "../src/docs.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "docs");
const LEGACY = join(here, "fixtures", "docs-legacy");

test("resolveDocsRoot prefers MCP_DOCS_PATH when it exists", () => {
  assert.equal(resolveDocsRoot({ MCP_DOCS_PATH: FIXTURE }), FIXTURE);
});

test("resolveDocsRoot derives the root from MCP_ARGS", () => {
  const root = resolveDocsRoot({ MCP_ARGS: join(FIXTURE, "dist", "index.js") });
  assert.equal(root, FIXTURE);
});

test("resolveDocsRoot returns null when nothing resolves", () => {
  assert.equal(resolveDocsRoot({ MCP_DOCS_PATH: "/nonexistent-xyz" }), null);
});

test("loadAgentDocs takes core rules from the centia-rules skill when present", async () => {
  const docs = await loadAgentDocs(FIXTURE);
  assert.equal(docs.coreRules?.source, "centia-rules");
  assert.match(docs.coreRules?.body ?? "", /Fixture Core Rules/);
  assert.doesNotMatch(docs.coreRules?.body ?? "", /^---/); // frontmatter stripped
  assert.match(docs.agentsMd ?? "", /AGENTS.md - Fixture/); // stub still read
  // centia-rules is not catalogued as an on-demand skill; broken-skill (no
  // frontmatter) is skipped.
  assert.deepEqual(
    docs.skills.map((s) => s.name),
    ["demo-skill"],
  );
  assert.equal(docs.skills[0]?.description, "A demo skill for tests.");
});

test("loadAgentDocs falls back to AGENTS.md as core rules (pre-1.0.36 layout)", async () => {
  const docs = await loadAgentDocs(LEGACY);
  assert.equal(docs.coreRules?.source, "AGENTS.md");
  assert.match(docs.coreRules?.body ?? "", /Legacy rule one/);
  assert.deepEqual(
    docs.skills.map((s) => s.name),
    ["demo-skill"],
  );
});

test("loadAgentDocs tolerates a missing root", async () => {
  const docs = await loadAgentDocs(null);
  assert.equal(docs.agentsMd, null);
  assert.equal(docs.coreRules, null);
  assert.deepEqual(docs.skills, []);
});

test("skillReader returns the full body for a known skill", async () => {
  const docs = await loadAgentDocs(FIXTURE);
  const read = skillReader(docs);
  const result = await read({ id: "t1", name: "readSkill", input: { name: "demo-skill" } });
  assert.equal(result.isError, false);
  assert.match(result.content, /Full body here/);
});

test("skillReader still serves centia-rules even though it is not catalogued", async () => {
  const docs = await loadAgentDocs(FIXTURE);
  const read = skillReader(docs);
  const result = await read({ id: "t1", name: "readSkill", input: { name: "centia-rules" } });
  assert.equal(result.isError, false);
  assert.match(result.content, /Rule one/);
});

test("skillReader fails closed on unknown or traversal-shaped names", async () => {
  const docs = await loadAgentDocs(FIXTURE);
  const read = skillReader(docs);
  for (const name of ["nope", "../../etc/passwd", "demo-skill/../broken-skill"]) {
    const result = await read({ id: "t1", name: "readSkill", input: { name } });
    assert.equal(result.isError, true, name);
    assert.match(result.content, /demo-skill/); // lists valid names
  }
});

test("READ_SKILL_TOOL shape", () => {
  assert.equal(READ_SKILL_TOOL.name, "readSkill");
  assert.ok((READ_SKILL_TOOL.description ?? "").length > 20);
});
