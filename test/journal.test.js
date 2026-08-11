import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRun, readRuns, journaledProjects, journalPath } from "../lib/journal.js";

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
