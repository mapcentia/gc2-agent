import { test } from "node:test";
import assert from "node:assert/strict";
import { McpPool, type McpSession } from "../src/mcpPool.js";

const makeFake = (log: string[]) => {
  let n = 0;
  return async (token: string): Promise<McpSession> => {
    const id = `${token}#${n++}`;
    log.push(`open ${id}`);
    return {
      tools: [],
      callTool: async () => ({ content: "{}", isError: false }),
      close: async () => { log.push(`close ${id}`); },
    };
  };
};

test("same token reuses the session; different token spawns", async () => {
  const log: string[] = [];
  const pool = new McpPool({ factory: makeFake(log) });
  const a1 = await pool.acquire("tokA");
  const a2 = await pool.acquire("tokA");
  await pool.acquire("tokB");
  assert.equal(a1, a2);
  assert.equal(pool.size(), 2);
  assert.deepEqual(log, ["open tokA#0", "open tokB#1"]);
});

test("reap closes idle sessions only", async () => {
  const log: string[] = [];
  let clock = 0;
  const pool = new McpPool({ factory: makeFake(log), ttlMs: 100, now: () => clock });
  await pool.acquire("tokA");
  clock = 50;
  await pool.acquire("tokB");
  clock = 130; // tokA idle 130 > 100; tokB idle 80
  await pool.reap();
  assert.equal(pool.size(), 1);
  assert.ok(log.includes("close tokA#0"));
});

test("evicts least-recently-used at maxSessions", async () => {
  const log: string[] = [];
  let clock = 0;
  const pool = new McpPool({ factory: makeFake(log), maxSessions: 2, now: () => clock++ });
  await pool.acquire("tokA");
  await pool.acquire("tokB");
  await pool.acquire("tokC");
  assert.equal(pool.size(), 2);
  assert.ok(log.includes("close tokA#0"));
});

test("failed spawn is not cached", async () => {
  let calls = 0;
  const pool = new McpPool({
    factory: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { tools: [], callTool: async () => ({ content: "", isError: false }), close: async () => {} };
    },
  });
  await assert.rejects(pool.acquire("tokA"), /boom/);
  await pool.acquire("tokA"); // retries instead of returning the rejected promise
  assert.equal(calls, 2);
});
