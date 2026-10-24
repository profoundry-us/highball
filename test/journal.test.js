import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRun, readRuns, journaledProjects, journalPath, resolveRunsLimit, workLabel
} from "../lib/journal.js";

const record = (n) => ({ started_at: `2026-08-11T0${n % 10}:00:00Z`, status: "passed", results: [] });

test("appendRun + readRuns round-trips, newest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-journal-"));

  appendRun("demo", record(1), dir);
  appendRun("demo", record(2), dir);

  const runs = readRuns("demo", dir);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].started_at, record(2).started_at);
});

test("the journal prunes to the last 200 runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-journal-"));

  for (let i = 0; i < 205; i++) appendRun("demo", { n: i }, dir);

  const runs = readRuns("demo", dir);
  assert.equal(runs.length, 200);
  assert.equal(runs[0].n, 204);
  assert.equal(runs.at(-1).n, 5);
});

test("corrupt lines are skipped, not fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-journal-"));
  appendRun("demo", record(1), dir);
  const path = journalPath("demo", dir);
  writeFileSync(path, readFileSync(path, "utf8") + "not json\n");
  appendRun("demo", record(2), dir);

  const runs = readRuns("demo", dir);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].started_at, record(2).started_at);
});

test("journaledProjects lists project files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-journal-"));
  appendRun("alpha", record(1), dir);
  appendRun("beta", record(1), dir);

  assert.deepEqual(journaledProjects(dir), [ "alpha", "beta" ]);
});

// The runner writes a run when it starts and again after every rule, all
// under one id: a run that dies mid-way still shows how far it got, and a
// finished one is still a single line.
test("a record with an id replaces its earlier self instead of appending", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-journal-"));

  appendRun("demo", { id: "run-1", status: "running", results: [] }, dir);
  appendRun("demo", { id: "run-1", status: "running", results: [ { id: "a" } ] }, dir);
  appendRun("demo", { id: "run-2", status: "running", results: [] }, dir);
  appendRun("demo", { id: "run-1", status: "passed", results: [ { id: "a" }, { id: "b" } ] }, dir);

  const runs = readRuns("demo", dir);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.id), [ "run-2", "run-1" ], "order is by first appearance, not last write");
  assert.equal(runs[1].status, "passed");
  assert.equal(runs[1].results.length, 2);
});

test("resolveRunsLimit: the call, then the env, then checks.yml, then the view's default", () => {
  assert.equal(resolveRunsLimit({ env: {}, fallback: 200 }), 200);
  assert.equal(resolveRunsLimit({ env: {}, config: { runs_limit: 40 }, fallback: 200 }), 40);
  assert.equal(resolveRunsLimit({ env: { HIGHBALL_RUNS_LIMIT: "60" }, config: { runs_limit: 40 } }), 60);
  assert.equal(resolveRunsLimit({ limit: 5, env: { HIGHBALL_RUNS_LIMIT: "60" } }), 5);
  assert.equal(resolveRunsLimit({ limit: 0, env: { HIGHBALL_RUNS_LIMIT: "lots" }, fallback: 7 }), 7);
});

test("workLabel: the prompt, else run by hand, else no prompt recorded", () => {
  assert.equal(workLabel({ session: "s1", work: "Fix the lint" }), "Fix the lint");
  assert.equal(workLabel({ session: null, work: null }), "run by hand");
  assert.equal(workLabel({ manual: true }), "run by hand");
  assert.equal(workLabel({ session: "s1", work: null }), "(no prompt recorded)");
});
