import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { treeFingerprint } from "../lib/stamp.js";
import { cliEnv } from "./helpers.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e"
};

function fixtureRepo({ fullPasses = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hb-ifchanged-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), [
    "version: 1",
    "project: if-changed-fixture",
    "checks:",
    "  - id: noop",
    "    name: Instant rule",
    '    run: "true"',
    "    fast: true",
    "  - id: slow",
    "    name: Full-only rule",
    `    run: "${fullPasses ? "true" : "false"}"`,
    ""
  ].join("\n"));
  execFileSync("git", [ "init", "-q" ], { cwd: dir });
  execFileSync("git", [ "add", "." ], { cwd: dir });
  execFileSync("git", [ "commit", "-q", "-m", "init" ], { cwd: dir, env: { ...process.env, ...GIT_ENV } });
  return dir;
}

// HOME is redirected so the journal and stamp land in a scratch dir
// rather than the developer's real ~/.highball.
function runFast(dir, home) {
  return execFileSync(process.execPath, [ CLI, "run", "--fast", "--if-changed" ], {
    cwd: dir, encoding: "utf8", env: cliEnv({ HOME: home }), stdio: [ "ignore", "pipe", "pipe" ]
  });
}

function runFull(dir, home) {
  return execFileSync(process.execPath, [ CLI, "run", "--if-changed" ], {
    cwd: dir, encoding: "utf8", env: cliEnv({ HOME: home }), stdio: [ "ignore", "pipe", "pipe" ]
  });
}

// Like runFull, for a suite expected to fail: the exit status instead of
// a throw.
function tryFull(dir, home) {
  const child = spawnSync(process.execPath, [ CLI, "run", "--if-changed" ], {
    cwd: dir, encoding: "utf8", env: cliEnv({ HOME: home }), stdio: [ "ignore", "pipe", "pipe" ]
  });
  return { status: child.status, stdout: child.stdout };
}

const journaledRuns = (home) => {
  try {
    return readFileSync(join(home, ".highball", "runs", "if-changed-fixture.jsonl"), "utf8")
      .split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

test("--if-changed runs once per working-tree state", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));

  // First run: no stamp yet, so it runs and journals.
  assert.match(runFast(dir, home), /Instant rule/);
  assert.equal(journaledRuns(home), 1);

  // Nothing moved: skipped, and nothing journaled.
  assert.match(runFast(dir, home), /skipped/);
  assert.equal(journaledRuns(home), 1);

  // A new untracked file changes the tree: runs again.
  writeFileSync(join(dir, "note.txt"), "hello");
  assert.match(runFast(dir, home), /Instant rule/);
  assert.equal(journaledRuns(home), 2);

  // Editing an already-dirty file moves its mtime: runs again.
  writeFileSync(join(dir, "note.txt"), "hello again");
  assert.match(runFast(dir, home), /Instant rule/);
  assert.equal(journaledRuns(home), 3);
});

// Git worktrees and parallel clones share a project name. A run in one must
// never let the other skip: the stamp is per checkout, not per project.
test("stamps are per checkout, so a second clone of the same project runs on its own", () => {
  const a = fixtureRepo();
  const b = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));

  assert.match(runFast(a, home), /Instant rule/);
  assert.match(runFast(b, home), /Instant rule/, "clone b must not inherit clone a's stamp");
  assert.match(runFast(a, home), /skipped/);
  assert.match(runFast(b, home), /skipped/);
  assert.equal(journaledRuns(home), 2);
});

// The hooked sequence after an edit: the fast hook runs and stamps, then
// the Stop hook runs the full suite. With one shared stamp the full run
// read the fast run's stamp and skipped, so the full-only rules never ran
// after an edit. Each mode keeps its own stamp now.
test("a fast run never makes the following full run skip", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));

  assert.match(runFast(dir, home), /Instant rule/);
  const full = runFull(dir, home);
  assert.match(full, /Full-only rule/, "the full run must run on the tree the fast run stamped");
  assert.doesNotMatch(full, /skipped/);
  assert.equal(journaledRuns(home), 2);

  // Same tree, second full run: nothing to add.
  assert.match(runFull(dir, home), /skipped/);
  assert.equal(journaledRuns(home), 2);

  // An edit stales both stamps; the whole sequence runs again.
  writeFileSync(join(dir, "note.txt"), "hello");
  assert.match(runFast(dir, home), /Instant rule/);
  assert.match(runFull(dir, home), /Full-only rule/);
  assert.equal(journaledRuns(home), 4);
});

// A full run is a superset of a fast run, so it may refresh the fast
// stamp: a read-only command after turn end should not pay for a fast run
// that has nothing to add.
test("a full run satisfies the following fast run on the same tree", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));

  assert.match(runFull(dir, home), /Full-only rule/);
  assert.match(runFast(dir, home), /skipped/);
  assert.equal(journaledRuns(home), 1);
});

// The Stop hook exists to block the agent on a red tree. A failed full run
// therefore leaves no full stamp: ending the turn again without an edit
// meets the same block, not a skip. The fast stamp is still written, so
// the reads in between don't re-run and re-block the fast lane.
test("a failed full run does not let the next full run on the same tree skip", () => {
  const dir = fixtureRepo({ fullPasses: false });
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));

  const first = tryFull(dir, home);
  assert.equal(first.status, 2);
  assert.match(first.stdout, /Full-only rule \.\.\. FAILED/);

  const second = tryFull(dir, home);
  assert.equal(second.status, 2, "the same red tree must block again");
  assert.doesNotMatch(second.stdout, /skipped/);
  assert.equal(journaledRuns(home), 2);

  // The fast lane on that tree is settled, though: it ran inside the full run.
  assert.match(runFast(dir, home), /skipped/);
});

test("treeFingerprint is null outside a git repo, so --if-changed never skips there", () => {
  assert.equal(treeFingerprint(mkdtempSync(join(tmpdir(), "hb-nogit-"))), null);
});
