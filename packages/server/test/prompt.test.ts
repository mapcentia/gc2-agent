import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContextBlock, SYSTEM_PROMPT } from "../src/prompt.js";

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
});
