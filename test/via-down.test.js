import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEnv } from "./helpers.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e"
};

// A wrapper is a command prefix. These stand in for `docker compose exec`:
//   HUNG    accepts anything and never answers — the daemon that stopped
//           responding on 2026-09-23.
//   HEALTHY runs whatever follows it unchanged.
const HUNG = "sh -c 'sleep 30' --";
const HEALTHY = "env";

function fixtureRepo(via) {
  const dir = mkdtempSync(join(tmpdir(), "hb-via-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), [
    "version: 1",
    "project: via-fixture",
    `exec:\n  via: ${via}`,
    "timeouts:\n  fast: 1",
    "checks:",
    "  - id: wrapped-a",
    "    name: Wrapped A",
    '    run: "true"',
    "    fast: true",
    "  - id: host-rule",
    "    name: Host rule",
    '    run: "echo host-ran"',
    "    exec: host",
    "    fast: true",
    "  - id: wrapped-b",
    "    name: Wrapped B",
    '    run: "true"',
    "    fast: true",
    "  - id: wrapped-c-hangs",
    "    name: Wrapped C (hangs on its own)",
    '    run: "sleep 30"',
    "    fast: true",
    ""
  ].join("\n"));
  execFileSync("git", [ "init", "-q" ], { cwd: dir });
  execFileSync("git", [ "commit", "-q", "--allow-empty", "-m", "init" ], { cwd: dir, env: { ...process.env, ...GIT_ENV } });
  return dir;
}

const freshHome = () => mkdtempSync(join(tmpdir(), "hb-home-"));

const runFast = (dir, home) => spawnSync(process.execPath, [ CLI, "run", "--fast" ], {
  cwd: dir, encoding: "utf8", env: cliEnv({ HOME: home }), stdio: [ "ignore", "pipe", "pipe" ]
});

function lastRun(home) {
  const path = join(home, ".highball", "runs", "via-fixture.jsonl");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse).at(-1);
}

// The dcc-mud incident: the first wrapped rule pays one budget, the probe
// confirms the wrapper is down, and the rest fail at once naming it. Host
// rules still run.
test("a hung wrapper is diagnosed once and the remaining wrapped rules fail immediately", () => {
  const dir = fixtureRepo(HUNG);
  const home = freshHome();
  const t0 = Date.now();
  const { status, stdout, stderr } = runFast(dir, home);
  const elapsed = Date.now() - t0;

  assert.equal(status, 2);
  // One budget for the rule, one for the probe, and nothing for the rest:
  // without the short-circuit this run would take three budgets plus.
  assert.ok(elapsed < 4500, `took ${elapsed}ms`);
  assert.match(stdout, /Wrapped A \.\.\. TIMED OUT \(1\.\ds\) — exec\.via isn't answering/);
  assert.match(stdout, /Host rule \.\.\. passed/);
  assert.match(stdout, /Wrapped B \.\.\. FAILED \(exec\.via isn't answering\)/);
  assert.match(stdout, /Wrapped C \(hangs on its own\) \.\.\. FAILED \(exec\.via isn't answering\)/);

  assert.match(stderr, /`exec\.via` isn't answering — the probe `sh -c 'sleep 30' -- true` hung for 1s and was killed/);
  assert.match(stderr, /rules marked `exec: host` are unaffected/);
  assert.match(stderr, /declared in \.highball\/checks\.yml/);
  assert.doesNotMatch(stderr, /raise it there/, "the budget advice is the wrong advice here");

  const run = lastRun(home);
  const byId = Object.fromEntries(run.results.map((r) => [ r.id, r ]));
  assert.equal(byId["wrapped-a"].timed_out, true);
  assert.equal(byId["wrapped-b"].status, "failed");
  assert.equal(byId["wrapped-b"].duration_ms, 0);
  assert.equal(byId["host-rule"].status, "passed");
});

// The journal records what actually ran, so a wrapper hang reads as one.
test("the journal records the wrapped command, not the bare rule", () => {
  const dir = fixtureRepo(HEALTHY);
  const home = freshHome();
  runFast(dir, home);
  const byId = Object.fromEntries(lastRun(home).results.map((r) => [ r.id, r ]));
  assert.equal(byId["wrapped-a"].command, "env true");
  assert.equal(byId["host-rule"].command, "echo host-ran");
});

// A healthy wrapper and a rule that hangs on its own: the probe answers,
// the rule takes the blame, and the run carries on as before.
test("when the wrapper answers, a hung rule is still the rule's fault and nothing is short-circuited", () => {
  const dir = fixtureRepo(HEALTHY);
  const home = freshHome();
  const { status, stdout, stderr } = runFast(dir, home);

  assert.equal(status, 2);
  assert.match(stdout, /Wrapped A \.\.\. passed/);
  assert.match(stdout, /Wrapped B \.\.\. passed/);
  assert.match(stdout, /Wrapped C \(hangs on its own\) \.\.\. TIMED OUT \(1\.\ds\)\n/);
  assert.doesNotMatch(stdout, /isn't answering/);
  assert.match(stderr, /ran through `exec\.via` \(`env`, from \.highball\/checks\.yml\); the wrapper answered a probe, so the rule itself is what hung/);
  assert.match(stderr, /raise it there if this rule legitimately needs longer/);
});
