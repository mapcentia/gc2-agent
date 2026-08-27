import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAgentsBlock, renderContextBlock, renderSkillCatalog, SYSTEM_PROMPT } from "../src/prompt.js";

test("context block renders app, description and data", () => {
  const block = renderContextBlock({
    app: "centia-app",
    description: "User is on the Map page",
    data: { schema: "jordforurening", activeLayers: ["a.b"] },
  });
  assert.match(block, /centia-app/);
  assert.match(block, /Map page/);
  assert.match(block, /jordforurening/);
});

test("system prompt covers provisioning + confirmation flow", () => {
  assert.match(SYSTEM_PROMPT, /confirmation/i);
  assert.match(SYSTEM_PROMPT, /postSql/);
  assert.match(SYSTEM_PROMPT, /never assume.*the_geom/is);
  assert.match(SYSTEM_PROMPT, /Never state that a change has been made/);
});

test("skill catalog lists names, descriptions and the readSkill instruction", () => {
  const block = renderSkillCatalog([
    { name: "demo-skill", description: "A demo skill." },
  ]);
  assert.match(block, /demo-skill/);
  assert.match(block, /A demo skill\./);
  assert.match(block, /readSkill/);
});

test("agents block wraps the raw AGENTS.md content", () => {
  const block = renderAgentsBlock("# Core Rules\n- Rule one.");
  assert.match(block, /Core Rules/);
  assert.match(block, /Rule one/);
});
