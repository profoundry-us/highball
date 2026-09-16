import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { treeFingerprint } from "../lib/stamp.js";
import { cliEnv } from "./helpers.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e"
};

// A committed wrapper that would fail on any host, so the run only passes
// if the checkout's own declaration replaced it.
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hb-local-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), [
    "version: 1",
    "project: local-fixture",
    "exec:",
    "  via: definitely-not-a-command",
    "checks:",
    "  - id: ok",
    "    name: Wrapped rule",
    '    run: "true"',
    "    fast: true",
    ""
  ].join("\n"));
  writeFileSync(join(dir, ".highball", ".gitignore"), "disabled\nchecks.local.yml\n");
  execFileSync("git", [ "init", "-q" ], { cwd: dir });
  execFileSync("git", [ "add", "." ], { cwd: dir });
  execFileSync("git", [ "commit", "-q", "-m", "init" ], { cwd: dir, env: { ...process.env, ...GIT_ENV } });
  return dir;
}

function run(dir, home, args, env = {}) {
  return execFileSync(process.execPath, [ CLI, "run", ...args ], {
    cwd: dir, encoding: "utf8", env: cliEnv({ HOME: home, ...env }), stdio: [ "ignore", "pipe", "pipe" ]
  });
}

test("the committed wrapper fails on this host, so the fixture proves something", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));
  assert.throws(() => run(dir, home, [ "--fast" ]), /Wrapped rule/);
});

test("checks.local.yml replaces the committed wrapper, and the run says so", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));
  writeFileSync(join(dir, ".highball", "checks.local.yml"), "exec:\n  via: sh -c\n");

  const out = run(dir, home, [ "--fast" ]);
  assert.match(out, /highball: rules run via `sh -c` \(\.highball\/checks\.local\.yml\)/);
  assert.match(out, /Wrapped rule \.\.\. passed/);
});

test("a local `via: null` runs on the host, with no wrapper line", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));
  writeFileSync(join(dir, ".highball", "checks.local.yml"), "exec:\n  via: null\n");

  const out = run(dir, home, [ "--fast" ]);
  assert.doesNotMatch(out, /rules run via/);
  assert.match(out, /Wrapped rule \.\.\. passed/);
});

test("HIGHBALL_EXEC_VIA wins over the files, and is named as the source", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));
  writeFileSync(join(dir, ".highball", "checks.local.yml"), "exec:\n  via: also-not-a-command\n");

  const out = run(dir, home, [ "--fast" ], { HIGHBALL_EXEC_VIA: "sh -c" });
  assert.match(out, /rules run via `sh -c` \(HIGHBALL_EXEC_VIA\)/);
  assert.match(out, /Wrapped rule \.\.\. passed/);
});

// The overlay is gitignored, so git status never sees it. An edit there
// changes how every rule runs and must not be skipped past.
test("editing checks.local.yml moves the fingerprint, so --if-changed runs again", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));
  writeFileSync(join(dir, ".highball", "checks.local.yml"), "exec:\n  via: sh -c\n");
  const before = treeFingerprint(dir);

  assert.match(run(dir, home, [ "--fast", "--if-changed" ]), /passed/);
  assert.match(run(dir, home, [ "--fast", "--if-changed" ]), /skipped/);

  writeFileSync(join(dir, ".highball", "checks.local.yml"), "exec:\n  via: null\n");
  assert.notEqual(treeFingerprint(dir), before);
  assert.match(run(dir, home, [ "--fast", "--if-changed" ]), /passed/);
});
