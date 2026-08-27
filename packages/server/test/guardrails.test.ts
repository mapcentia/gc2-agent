import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTool, isReadOnlySql, filterExposedTools } from "../src/guardrails.js";

test("get* tools are read", () => {
  assert.equal(classifyTool("getSchema"), "read");
  assert.equal(classifyTool("getLayer"), "read");
  assert.equal(classifyTool("getKeyvalue"), "read");
});

test("postSql is read (regex-guarded elsewhere)", () => {
  assert.equal(classifyTool("postSql"), "read");
});

test("write tools require approval", () => {
  assert.equal(classifyTool("postSchema"), "write");
  assert.equal(classifyTool("patchLayer"), "write");
  assert.equal(classifyTool("deleteTable"), "write");
  assert.equal(classifyTool("postLayerClass"), "write");
  assert.equal(classifyTool("patchKeyvalue"), "write");
  assert.equal(classifyTool("postGraphQL"), "write");
  assert.equal(classifyTool("postCallDry"), "write");
});

test("auth-sensitive tools are denied", () => {
  for (const name of [
    "postOauth", "postDevice", "postClient", "patchClient", "deleteClient",
    "postUser", "patchUser", "deleteUsers", "postSqlNoToken",
  ]) {
    assert.equal(classifyTool(name), "deny", name);
  }
});

test("unknown names are denied", () => {
  assert.equal(classifyTool("dropEverything"), "deny");
});

test("read-only SQL guard", () => {
  assert.equal(isReadOnlySql("SELECT 1"), true);
  assert.equal(isReadOnlySql("  with x as (select 1) select * from x"), true);
  assert.equal(isReadOnlySql("-- comment\nEXPLAIN SELECT 1"), true);
  assert.equal(isReadOnlySql("DELETE FROM t"), false);
  assert.equal(isReadOnlySql("INSERT INTO t VALUES (1)"), false);
  assert.equal(isReadOnlySql(42), false);
});

test("filterExposedTools removes deny and sorts by name", () => {
  const tools = [
    { name: "postSchema" }, { name: "deleteUsers" }, { name: "getTable" },
  ];
  assert.deepEqual(
    filterExposedTools(tools).map((t) => t.name),
    ["getTable", "postSchema"],
  );
});
