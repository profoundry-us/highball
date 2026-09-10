import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cliEnv } from "./helpers.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e"
};

// A rule that outlives any budget and leaves its grandchild's pid behind,
// so "did the kill reach the whole tree?" is answered by the OS rather
// than by trusting the runner's own report.
const LINGERING = "sh -c 'sleep 30 & echo $! > child.pid; wait'";

function fixtureRepo(rules, top = []) {
  const dir = mkdtempSync(join(tmpdir(), "hb-timeout-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), [
    "version: 1",
    "project: timeout-fixture",
    ...top,
    "checks:",
    ...rules,
    ""
  ].join("\n"));
  execFileSync("git", [ "init", "-q" ], { cwd: dir });
  execFileSync("git", [ "commit", "-q", "--allow-empty", "-m", "init" ], {
    cwd: dir, env: { ...process.env, ...GIT_ENV }
  });
  return dir;
}

const freshHome = () => mkdtempSync(join(tmpdir(), "hb-home-"));

const runCli = (dir, home, args = [ "run", "--fast" ]) =>
  spawnSync(process.execPath, [ CLI, ...args ], {
    cwd: dir, encoding: "utf8", env: cliEnv({ HOME: home }),
    stdio: [ "ignore", "pipe", "pipe" ]
  });

// Newest first, like readRuns.
function journal(home) {
  const path = join(home, ".highball", "runs", "timeout-fixture.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse).reverse();
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function eventually(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

const grandchildPid = (dir) => Number(readFileSync(join(dir, "child.pid"), "utf8").trim());

test("a rule past its budget is killed with its whole process tree, fails, and says why", async () => {
  const dir = fixtureRepo([
    "  - id: hangs",
    "    name: A rule that hangs",
    `    run: "${LINGERING}"`,
    "    timeout: 1",
    "    fast: true"
  ]);
  const home = freshHome();

  const started = Date.now();
  const { status, stdout, stderr } = runCli(dir, home);
  const took = Date.now() - started;

  assert.equal(status, 2, "a timed-out rule blocks the agent like any other failure");
  assert.ok(took < 8000, `the run should end at the budget, not at the rule's own pace (took ${took}ms)`);
  assert.match(stdout, /A rule that hangs \.\.\. TIMED OUT/);
  assert.match(stderr, /### A rule that hangs \(hangs\) failed/);
  assert.match(stderr, /timed out after 1s and was killed/);
  assert.match(stderr, /`timeout: 1` on this rule/, "the advice names the knob that set the budget");

  const [ run ] = journal(home);
  assert.equal(run.status, "failed");
  assert.equal(run.results[0].status, "failed");
  assert.equal(run.results[0].timed_out, true);
  assert.ok(run.results[0].duration_ms >= 900 && run.results[0].duration_ms < 5000);
  assert.match(run.results[0].output_tail, /timed out after 1s/);

  // The sleep was started by a shell started by the rule's shell. Killing
  // only the top of that tree is what leaves hung suites running on.
  const pid = grandchildPid(dir);
  assert.ok(await eventually(() => !alive(pid)), `grandchild ${pid} should have died with the rule`);
});

test("a rule with no timeout of its own is told which default it ran into", () => {
  const dir = fixtureRepo([
    "  - id: hangs",
    "    name: Hangs on the default",
    `    run: "${LINGERING}"`,
    "    fast: true"
  ], [ "timeouts:", "  fast: 1" ]);
  const home = freshHome();

  const { status, stderr } = runCli(dir, home);
  assert.equal(status, 2);
  assert.match(stderr, /`timeouts\.fast: 1`/);
});

test("a rule inside its budget is untouched, and the run is one journal record from start to finish", () => {
  const dir = fixtureRepo([
    "  - id: quick",
    "    name: Quick",
    '    run: "echo hello"',
    "    fast: true",
    "  - id: quick-too",
    "    name: Quick too",
    '    run: "true"',
    "    fast: true"
  ]);
  const home = freshHome();

  const { status, stdout } = runCli(dir, home);
  assert.equal(status, 0);
  assert.match(stdout, /Quick \.\.\. passed/);

  // Written when the run started and rewritten after each rule: still
  // exactly one record, now finished.
  const runs = journal(home);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "passed");
  assert.equal(runs[0].results.length, 2);
  assert.equal(runs[0].results[0].output_tail, "hello\n");
  assert.equal(runs[0].results[0].timed_out, undefined, "ordinary results carry no runner-failure flags");
});

// The case the whole change exists for: the runner itself is stopped —
// Claude Code giving up on the hook, a closed terminal — in the middle of
// a rule. Before, that left a hung suite running and no journal record at
// all; the hang was invisible precisely when it mattered.
test("a stopped runner takes the running rule down with it and journals the run as killed", async () => {
  const dir = fixtureRepo([
    "  - id: hangs",
    "    name: Still going",
    `    run: "${LINGERING}"`,
    "    timeout: 60",
    "    fast: true"
  ]);
  const home = freshHome();

  const runner = spawn(process.execPath, [ CLI, "run", "--fast" ], {
    cwd: dir, env: cliEnv({ HOME: home }), stdio: [ "ignore", "pipe", "pipe" ]
  });
  let stderr = "";
  runner.stderr.setEncoding("utf8");
  runner.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => runner.on("close", resolve));

  // The rule is running (its grandchild has reported in) and the journal
  // already knows about the run.
  assert.ok(await eventually(() => existsSync(join(dir, "child.pid"))), "the rule should have started");
  assert.ok(await eventually(() => journal(home)[0]?.status === "running"), "the run should be journaled as running before it ends");
  const pid = grandchildPid(dir);

  runner.kill("SIGTERM");
  assert.equal(await exited, 1, "a stopped run is neither a pass nor an ordinary failure");
  assert.match(stderr, /stopped by SIGTERM — run journaled as killed/);

  const runs = journal(home);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "killed");
  assert.equal(runs[0].results[0].status, "failed");
  assert.equal(runs[0].results[0].killed, true);
  assert.match(runs[0].results[0].output_tail, /stopped \(SIGTERM\)/);
  assert.ok(await eventually(() => !alive(pid)), `grandchild ${pid} should not outlive the runner`);
});
