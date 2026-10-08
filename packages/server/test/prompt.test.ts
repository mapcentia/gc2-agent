import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContextBlock, renderCoreRulesBlock, renderSkillCatalog, SYSTEM_PROMPT } from "../src/prompt.js";

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
  assert.match(SYSTEM_PROMPT, /PARALLEL tool calls in a single response/);
  assert.match(SYSTEM_PROMPT, /one aggregate call/);
  assert.match(SYSTEM_PROMPT, /ONE atomic postLayer/);
  assert.match(SYSTEM_PROMPT, /NEVER loop patchLayerClass, patchStyle, patchLabel/);
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

test("core rules block wraps the rules and maps skill paths onto readSkill", () => {
  const block = renderCoreRulesBlock("# Core Rules\n- Rule one.", "centia-rules");
  assert.match(block, /Core Rules/);
  assert.match(block, /Rule one/);
  assert.match(block, /centia-rules/);
  assert.match(block, /readSkill/);
  assert.match(renderCoreRulesBlock("x", "AGENTS.md"), /AGENTS\.md/);
});
