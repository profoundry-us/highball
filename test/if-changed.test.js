import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { treeFingerprint } from "../lib/stamp.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e"
};

function fixtureRepo() {
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
    cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home }, stdio: [ "ignore", "pipe", "pipe" ]
  });
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

test("treeFingerprint is null outside a git repo, so --if-changed never skips there", () => {
  assert.equal(treeFingerprint(mkdtempSync(join(tmpdir(), "hb-nogit-"))), null);
});
