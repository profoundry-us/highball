import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createPool } from "../lib/pool.js";

async function peak(size, tasks) {
  const pool = createPool(size);
  let inFlight = 0;
  let most = 0;
  const order = [];
  await Promise.all(Array.from({ length: tasks }, (_, i) => pool.run(async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await sleep(20);
    order.push(i);
    inFlight -= 1;
  })));
  return { most, order };
}

test("a pool never runs more than its size at once, and starts waiters in order", async () => {
  assert.equal((await peak(2, 6)).most, 2);
  assert.equal((await peak(1, 4)).most, 1);
  assert.deepEqual((await peak(1, 4)).order, [ 0, 1, 2, 3 ]);
  assert.equal((await peak(Infinity, 5)).most, 5);
});

test("a task that throws still releases its slot", async () => {
  const pool = createPool(1);
  await assert.rejects(pool.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await pool.run(async () => "next"), "next");
});
