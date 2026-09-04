import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFileSync as run } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e"
};

// A repo whose single rule writes a file, so "did the checks actually run?"
// is answered by the filesystem rather than by parsing stdout.
function fixtureRepo(extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "hb-disabled-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), [
    "version: 1",
    "project: disabled-fixture",
    extra,
    "checks:",
    "  - id: ran",
    "    name: Leaves a trace",
    '    run: "touch ran.marker"',
    "    fast: true",
    ""
  ].filter(Boolean).join("\n"));
  execFileSync("git", [ "init", "-q" ], { cwd: dir });
  execFileSync("git", [ "commit", "-q", "--allow-empty", "-m", "init" ], {
    cwd: dir, env: { ...process.env, ...GIT_ENV }
  });
  return dir;
}

const runFast = (dir, env = {}) => run(process.execPath, [ CLI, "run", "--fast" ], {
  cwd: dir, encoding: "utf8", env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "hb-home-")), ...env }
});

const ranChecks = (dir) => existsSync(join(dir, "ran.marker"));

test("enabled: false turns the repo off without touching its rules", () => {
  const dir = fixtureRepo("enabled: false");
  const output = runFast(dir);

  assert.match(output, /disabled by `enabled: false`/);
  assert.equal(ranChecks(dir), false, "no rule should have run");
});

test("enabled: true is the same as saying nothing", () => {
  const dir = fixtureRepo("enabled: true");
  runFast(dir);
  assert.equal(ranChecks(dir), true);
});

const marker = (dir) => join(dir, ".highball", "disabled");

test(".highball/disabled turns off just this checkout", () => {
  const dir = fixtureRepo();
  writeFileSync(marker(dir), "");

  const output = runFast(dir);
  assert.match(output, /disabled by \.highball\/disabled/);
  assert.equal(ranChecks(dir), false);
});

// The point of a file switch over the environment variable: it is re-read
// every run, so it toggles inside a live agent session with no restart.
test("the marker toggles both ways with no restart and no leftover state", () => {
  const dir = fixtureRepo();

  runFast(dir);
  assert.equal(ranChecks(dir), true, "no marker: checks run");

  rmSync(join(dir, "ran.marker"));
  writeFileSync(marker(dir), "");
  runFast(dir);
  assert.equal(ranChecks(dir), false, "marker added: skipped on the very next run");

  rmSync(marker(dir));
  runFast(dir);
  assert.equal(ranChecks(dir), true, "marker removed: re-armed on the very next run");
});

// Whoever finds the checks off a week later deserves to know why.
test("text in the marker is echoed back as the reason", () => {
  const dir = fixtureRepo();
  writeFileSync(marker(dir), "bisecting a flaky test\nsecond line ignored\n");

  assert.match(runFast(dir), /disabled by \.highball\/disabled \(bisecting a flaky test\)/);
});

test("the marker works even when checks.yml is unloadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-disabled-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), "project: broken\n");
  writeFileSync(marker(dir), "");

  assert.match(runFast(dir), /disabled by \.highball\/disabled/);
});

// A switch-off that ships to everyone is the failure this file switch exists
// to avoid, so the ignore rule has to arrive with the scaffold, not with a
// setup step someone has to remember.
test("init ships the .gitignore that keeps the marker local", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-init-"));
  execFileSync("git", [ "init", "-q" ], { cwd: dir });
  run(process.execPath, [ CLI, "init" ], { cwd: dir, encoding: "utf8" });

  assert.match(
    readFileSync(join(dir, ".highball", ".gitignore"), "utf8"),
    /^disabled$/m
  );

  writeFileSync(marker(dir), "");
  const tracked = run("git", [ "status", "--porcelain", "--untracked-files=all" ], {
    cwd: dir, encoding: "utf8"
  });
  assert.doesNotMatch(tracked, /disabled/, "the marker must not show up as a file to commit");
});

test("HIGHBALL_DISABLED turns it off per machine, with nothing committed", () => {
  const dir = fixtureRepo();
  const output = runFast(dir, { HIGHBALL_DISABLED: "1" });

  assert.match(output, /disabled by HIGHBALL_DISABLED/);
  assert.equal(ranChecks(dir), false);
});

// The mid-task escape hatch has to work when checks.yml is the thing in the
// way; a disable that still needs a loadable config would be useless exactly
// when it's wanted most.
test("HIGHBALL_DISABLED works even when checks.yml is unloadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-disabled-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), "project: broken\n");

  const output = runFast(dir, { HIGHBALL_DISABLED: "1" });
  assert.match(output, /disabled by HIGHBALL_DISABLED/);
});

// Plain truthiness would make HIGHBALL_DISABLED=0 stop every check, which is
// the opposite of what anyone typing 0 means.
test("falsey spellings of HIGHBALL_DISABLED leave the checks running", () => {
  for (const value of [ "0", "false", "FALSE", "no", "off", "", " 0 " ]) {
    const dir = fixtureRepo();
    runFast(dir, { HIGHBALL_DISABLED: value });
    assert.equal(ranChecks(dir), true, `HIGHBALL_DISABLED=${JSON.stringify(value)} should not disable`);
  }
});

test("truthy spellings of HIGHBALL_DISABLED all disable", () => {
  for (const value of [ "1", "true", "yes", "on", "whatever" ]) {
    const dir = fixtureRepo();
    runFast(dir, { HIGHBALL_DISABLED: value });
    assert.equal(ranChecks(dir), false, `HIGHBALL_DISABLED=${JSON.stringify(value)} should disable`);
  }
});

// `enabled: no` is the string "no" under YAML 1.2, and `enabled: "false"` is
// a string — both truthy. Failing loudly beats running checks the author
// believed were switched off.
test("a non-boolean enabled: is an error, not a silent no-op", () => {
  for (const value of [ '"false"', "no", "0" ]) {
    const dir = fixtureRepo(`enabled: ${value}`);
    assert.throws(
      () => runFast(dir),
      (error) => /`enabled:` must be true or false/.test(error.stderr),
      `enabled: ${value} should be rejected`
    );
    assert.equal(ranChecks(dir), false);
  }
});
