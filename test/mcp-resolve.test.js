import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRun } from "../lib/journal.js";
import {
  DEFAULT_RUNS_LIMIT, listText, resolveProject, resolveRunsLimit
} from "../lib/mcp.js";

const scratch = (label) => mkdtempSync(join(tmpdir(), `hb-${label}-`));

// A repo root with a minimal checks.yml naming `project`.
const repo = (project, extra = "") => {
  const root = scratch("repo");
  mkdirSync(join(root, ".highball"));
  writeFileSync(
    join(root, ".highball/checks.yml"),
    `version: 1\nproject: ${project}\n${extra}checks: []\n`
  );
  return root;
};

const journaled = (project, dir) => {
  const journalDir = scratch("journal");
  appendRun(project, { started_at: "2026-09-02T00:00:00Z", dir, results: [] }, journalDir);
  return journalDir;
};

test("resolveProject never falls back to another repo's journal", () => {
  // The machine has recent runs for some other project; the cwd has no
  // checks.yml. The old behaviour showed that other project — silently.
  const journalDir = journaled("someone-elses", "/elsewhere");
  const resolved = resolveProject({ cwd: scratch("bare"), journalDir });
  assert.deepEqual(resolved, { project: null, dir: null, config: null });
});

test("resolveProject reads checks.yml at cwd, at dir, or at a client root", () => {
  const root = repo("mine", "runs_limit: 7\n");
  const bare = scratch("bare");

  const viaCwd = resolveProject({ cwd: root });
  assert.equal(viaCwd.project, "mine");
  assert.equal(viaCwd.dir, root);
  assert.equal(viaCwd.config.runs_limit, 7);

  assert.equal(resolveProject({ cwd: bare, dir: root }).project, "mine");

  const viaRoot = resolveProject({ cwd: bare, roots: [ bare, root ] });
  assert.equal(viaRoot.project, "mine");
  assert.equal(viaRoot.dir, root);
});

test("an explicit project wins and grounds its dir from the journal", () => {
  const journalDir = journaled("explicit", "/repo/explicit");
  const resolved = resolveProject({ project: "explicit", cwd: repo("other"), journalDir });
  assert.equal(resolved.project, "explicit");
  assert.equal(resolved.dir, "/repo/explicit");
});

test("resolveRunsLimit: the call, then the env, then checks.yml, then 25", () => {
  assert.equal(DEFAULT_RUNS_LIMIT, 25);
  assert.equal(resolveRunsLimit({ env: {} }), 25);
  assert.equal(resolveRunsLimit({ env: {}, config: { runs_limit: 40 } }), 40);
  assert.equal(
    resolveRunsLimit({ env: { HIGHBALL_RUNS_LIMIT: "60" }, config: { runs_limit: 40 } }),
    60
  );
  assert.equal(resolveRunsLimit({ limit: 5, env: { HIGHBALL_RUNS_LIMIT: "60" } }), 5);
  // Garbage at every level falls through to the default rather than to 0 or NaN.
  assert.equal(
    resolveRunsLimit({ limit: -1, env: { HIGHBALL_RUNS_LIMIT: "lots" }, config: { runs_limit: 0 } }),
    25
  );
});

test("listText says up front when the list is cut short", () => {
  const runs = [ {
    index: 1, started_at: "2026-08-12T01:00:00Z", duration_ms: 1000,
    trigger: "stop", branch: "main", status: "passed", results: []
  } ];
  assert.match(listText("demo", runs, 200), /last 1 of 200/);
  assert.match(listText("demo", runs, 200), /HIGHBALL_RUNS_LIMIT/);
  assert.doesNotMatch(listText("demo", runs), /last 1 of/);
});
