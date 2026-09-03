import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFileSync as run } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
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
