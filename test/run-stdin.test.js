import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEnv } from "./helpers.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hb-stdin-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), [
    "version: 1",
    "project: stdin-fixture",
    "checks:",
    "  - id: noop",
    "    name: Instant rule",
    '    run: "true"',
    "    fast: true",
    ""
  ].join("\n"));
  execFileSync("git", [ "init", "-q" ], { cwd: dir });
  execFileSync("git", [ "commit", "-q", "--allow-empty", "-m", "init" ], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" }
  });
  return dir;
}

// A hook writes its payload and closes. Every OTHER non-terminal caller — an
// agent's shell tool, a CI step, an npm script — hands us a pipe nobody ever
// closes, and reading it to EOF would stall the run before the first check.
//
// Timed on the CHILD, deliberately: `time (sleep 8 | highball run)` measures
// the PIPELINE and can never report less than the writer's lifetime, which has
// twice now been mistaken for the runner hanging.
test("run exits promptly when stdin is a pipe nobody closes", async () => {
  const dir = fixtureRepo();
  const startedAt = Date.now();

  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ CLI, "run", "--fast" ], {
      cwd: dir,
      env: cliEnv(),
      stdio: [ "pipe", "ignore", "ignore" ] // stdin open, never written, never closed
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("highball run did not exit — it is waiting on stdin EOF"));
    }, 15_000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });

  const elapsed = Date.now() - startedAt;
  assert.equal(code, 0);
  // Generous: the point is bounded, not fast. A regression here means waiting
  // on the writer, which is unbounded rather than merely slow.
  assert.ok(elapsed < 10_000, `took ${elapsed}ms — expected a bounded wait`);
});

// A hook hands the runner its session; nothing else does. A run without one
// was started by hand (a terminal, a dashboard re-run button) and is
// journaled that way, so history views group it as such.
const lastJournaled = (home) => JSON.parse(
  readFileSync(join(home, ".highball", "runs", "stdin-fixture.jsonl"), "utf8").trim().split("\n").at(-1)
);

test("a run with no hook payload is journaled as manual", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-stdin-home-"));
  const child = spawnSync(process.execPath, [ CLI, "run", "--fast" ], {
    cwd: dir, env: cliEnv({ HOME: home }), input: ""
  });
  assert.equal(child.status, 0);
  const run = lastJournaled(home);
  assert.equal(run.session, null);
  assert.equal(run.manual, true);
});

test("a run a hook started carries its session and isn't manual", () => {
  const dir = fixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "hb-stdin-home-"));
  const child = spawnSync(process.execPath, [ CLI, "run", "--fast" ], {
    cwd: dir, env: cliEnv({ HOME: home }), input: JSON.stringify({ session_id: "sess-1" })
  });
  assert.equal(child.status, 0);
  const run = lastJournaled(home);
  assert.equal(run.session, "sess-1");
  assert.equal(run.manual, undefined);
});
