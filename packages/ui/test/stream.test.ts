import { test } from "node:test";
import assert from "node:assert/strict";
import { createNdjsonSplitter } from "../src/stream.js";

test("splits complete lines across chunk boundaries", () => {
  const lines: string[] = [];
  const s = createNdjsonSplitter((l) => lines.push(l));
  s.push('{"a":1}\n{"b"');
  s.push(':2}\n');
  s.push('{"c":3}');
  s.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("ignores empty lines", () => {
  const lines: string[] = [];
  const s = createNdjsonSplitter((l) => lines.push(l));
  s.push("\n\n{\"a\":1}\n\n");
  s.flush();
  assert.deepEqual(lines, ['{"a":1}']);
});
