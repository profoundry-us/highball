// `highball runs` end to end: the CLI spawned against a fixture repo and a
// journal in a scratch HOME. Listed in tests-for-changed's SLOW set, since
// every case spawns node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRun } from "../lib/journal.js";
import { cliEnv } from "./helpers.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hb-runs-home-"));
  const repo = mkdtempSync(join(tmpdir(), "hb-runs-repo-"));
  mkdirSync(join(repo, ".highball"));
  writeFileSync(join(repo, ".highball", "checks.yml"),
    "version: 1\nproject: runs-fixture\nchecks:\n  - id: tests\n    run: \"true\"\n");
  mkdirSync(join(repo, "app", "models"), { recursive: true });
  const journal = join(home, ".highball", "runs");
  // Oldest first, as the runner writes them.
  appendRun("runs-fixture", {
    id: "4f2a1cbb-0000-4000-8000-000000000001", started_at: ago(60), duration_ms: 88_700,
    trigger: "stop", branch: "main", commit: "1c2d3e4f5", status: "failed",
    session: "s1", work: "Fix the blueprint lint",
    results: [
      { id: "lint", name: "Lint", status: "passed", duration_ms: 2_100, command: "npm run lint" },
      { id: "tests", name: "Unit tests", status: "failed", duration_ms: 82_000,
        command: "npm test", output_tail: "not ok 41 - nested rules\n" },
      { id: "style", name: "Style rubric", status: "failed", duration_ms: 4_000,
        command: "judge .highball/rubrics/style.md", output_tail: "app/x.js:3 too clever\n" }
    ]
  }, journal);
  appendRun("runs-fixture", {
    id: "9be031cc-0000-4000-8000-000000000002", started_at: ago(6), duration_ms: 1_400,
    trigger: "edit", branch: "main", status: "passed", session: "s2", work: "Add the Profiling guide",
    results: [ { id: "lint", name: "Lint", status: "passed", duration_ms: 1_400 } ]
  }, journal);
  appendRun("runs-fixture", {
    id: "c7d85500-0000-4000-8000-000000000003", started_at: ago(4), duration_ms: 90_200,
    trigger: "stop", branch: "main", status: "passed", session: null, work: null, manual: true,
    results: [
      { id: "lint", name: "Lint", status: "passed", duration_ms: 2_000 },
      { id: "tests", name: "Unit tests", status: "passed", duration_ms: 84_000 }
    ]
  }, journal);
  return { home, repo };
}

const highball = ({ home }, cwd, ...args) => {
  const result = spawnSync(process.execPath, [ CLI, "runs", ...args ], {
    cwd, encoding: "utf8", env: cliEnv({ HOME: home, NO_COLOR: "1", FORCE_COLOR: "" })
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
};

test("runs lists history with ids, grouped by prompt, from any subdirectory", () => {
  const env = fixture();
  const { status, out } = highball(env, join(env.repo, "app", "models"));
  assert.equal(status, 0);
  assert.match(out, /Recent runs for runs-fixture/);
  assert.match(out, /» run by hand\n\s+#1\s+c7d855\s+4m ago\s+full/);
  assert.match(out, /» Add the Profiling guide\n\s+#2\s+9be031\s+6m ago\s+fast/);
  assert.match(out, /#3\s+4f2a1c\s+1h ago\s+full\s+main\s+88\.7s\s+✗ FAILED/);
  assert.match(out, /Detail: highball runs <number or id>/);
  assert.doesNotMatch(out, /Newest \d+ of/, "no limit, no truncation note");
});

test("runs --limit=N shows the newest N and says how many it left out", () => {
  const env = fixture();
  const { status, out } = highball(env, env.repo, "--limit=1");
  assert.equal(status, 0);
  assert.match(out, /#1\s+c7d855/);
  assert.doesNotMatch(out, /#2/);
  assert.match(out, /Newest 1 of 3\. More: highball runs --limit=<n>/);
});

test("runs <id> shows the same run as its number, with a rerun line for a failed command", () => {
  const env = fixture();
  const byNumber = highball(env, env.repo, "3");
  const byId = highball(env, env.repo, "4f2a1c");
  assert.equal(byId.status, 0);
  assert.equal(byId.out, byNumber.out);
  assert.match(byId.out, /Run #3 \(4f2a1c\) — runs-fixture · full suite · main · 1c2d3e4/);
  assert.match(byId.out, /not ok 41 - nested rules\n\s+rerun by hand: npm test/);
  assert.doesNotMatch(byId.out, /rerun by hand: judge/, "an AI judge has no command to rerun");
  assert.doesNotMatch(byId.out, /rerun by hand: npm run lint/, "only failed rules get one");
});

test("runs --slowest ranks the rules of recent full runs", () => {
  const env = fixture();
  const { status, out } = highball(env, env.repo, "--slowest");
  assert.equal(status, 0);
  assert.match(out, /Slowest checks for runs-fixture over the last 2 full runs, a typical run takes 89\.5s:/);
  const lines = out.split("\n").filter((line) => /median/.test(line) && !/typical/.test(line));
  assert.match(lines[0], /^\s+Unit tests\s+2 runs\s+median 83\.0s\s+max 84\.0s\s+93% of a run$/);
  assert.match(lines.at(-1), /Lint/);
});

test("runs explains a bad target or option instead of guessing", () => {
  const env = fixture();
  assert.match(highball(env, env.repo, "abcdef").err, /no run with id abcdef/);
  assert.match(highball(env, env.repo, "--limit", "25").err, /unknown option `--limit`/);
  const outside = highball(env, mkdtempSync(join(tmpdir(), "hb-runs-none-")));
  assert.equal(outside.status, 1);
  assert.match(outside.err, /no \.highball\/checks\.yml here or above/);
  assert.match(outside.err, /Projects with local history: runs-fixture/);
});
