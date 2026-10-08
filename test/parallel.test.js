import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cliEnv } from "./helpers.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e"
};

// A stand-in `claude` that takes `seconds` to pass every bundle it's given.
function fakeClaude(seconds) {
  const dir = mkdtempSync(join(tmpdir(), "hb-claude-"));
  writeFileSync(join(dir, "claude"), [
    "#!/bin/sh",
    "cat > /dev/null",
    `sleep ${seconds}`,
    `printf '%s' '{"result":"{\\"status\\":\\"passed\\",\\"offenses\\":[]}"}'`,
    ""
  ].join("\n"));
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

function fixtureRepo(lines) {
  const dir = mkdtempSync(join(tmpdir(), "hb-parallel-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), [ "version: 1", "project: parallel-fixture", ...lines, "" ].join("\n"));
  writeFileSync(join(dir, ".highball", "r.md"), "---\ninclude: \"**/*.rb\"\n---\nAnything goes.\n");
  execFileSync("git", [ "init", "-q" ], { cwd: dir });
  execFileSync("git", [ "add", "." ], { cwd: dir });
  execFileSync("git", [ "commit", "-q", "-m", "init" ], { cwd: dir, env: { ...process.env, ...GIT_ENV } });
  // Untracked, so it's in the changed list the judges read.
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "x.rb"), "puts 1\n");
  return dir;
}

const rule = (id, run, extra = []) => [ `  - id: ${id}`, `    name: ${id}`, `    run: "${run}"`, ...extra ];
const judged = (id, extra = []) => [ `  - id: ${id}`, `    name: ${id}`, "    rubric: .highball/r.md", ...extra ];

function runFull(dir, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));
  const t0 = Date.now();
  const child = spawnSync(process.execPath, [ CLI, "run" ], {
    cwd: dir, encoding: "utf8", env: cliEnv({ HOME: home, ...env }), stdio: [ "ignore", "pipe", "pipe" ]
  });
  return { ...child, elapsed: Date.now() - t0, home };
}

const journal = (home) => {
  const path = join(home, ".highball", "runs", "parallel-fixture.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
};

test("parallel: true rules run alongside the sequential lane, and the run takes as long as the slowest", () => {
  const dir = fixtureRepo([
    "checks:",
    ...rule("first", "sleep 1"),
    ...rule("side-a", "sleep 1", [ "    parallel: true" ]),
    ...rule("side-b", "sleep 1", [ "    parallel: true" ]),
    ...rule("last", "true")
  ]);
  const { status, stdout, elapsed, home } = runFull(dir);

  assert.equal(status, 0, stdout);
  assert.ok(elapsed < 2500, `took ${elapsed}ms; sequentially it would be 3s+`);
  assert.match(stdout, /highball: running alongside the rest: side-a, side-b/);
  for (const id of [ "first", "side-a", "side-b", "last" ]) {
    assert.match(stdout, new RegExp(`^→ ${id} \\.\\.\\. passed \\(\\d+\\.\\ds\\)$`, "m"), `${id} gets an unbroken line`);
  }
  const run = journal(home).at(-1);
  assert.equal(run.status, "passed");
  assert.deepEqual(run.results.map((r) => r.id), [ "first", "side-a", "side-b", "last" ], "journaled in config order");
});

test("concurrency: caps how many rules run alongside at once", () => {
  const dir = fixtureRepo([
    "concurrency: 1",
    "checks:",
    ...rule("a", "sleep 0.5", [ "    parallel: true" ]),
    ...rule("b", "sleep 0.5", [ "    parallel: true" ]),
    ...rule("c", "sleep 0.5", [ "    parallel: true" ])
  ]);
  const { status, elapsed } = runFull(dir);
  assert.equal(status, 0);
  assert.ok(elapsed >= 1500, `took ${elapsed}ms; one at a time is 1.5s+`);
});

// The webtree run spent 145s of 169s on two judges, one after the other,
// after the scripts. Rubric rules now run alongside from the start.
test("rubric rules run alongside each other and the scripts by default", () => {
  const dir = fixtureRepo([
    "checks:",
    ...rule("suite", "sleep 1"),
    ...judged("comments"),
    ...judged("architecture")
  ]);
  const { status, stdout, elapsed } = runFull(dir, { PATH: `${fakeClaude(1)}:${process.env.PATH}` });

  assert.equal(status, 0, stdout);
  assert.ok(elapsed < 2500, `took ${elapsed}ms; sequentially it would be 3s+`);
  assert.match(stdout, /^→ comments \.\.\. passed/m);
  assert.match(stdout, /^→ architecture \.\.\. passed/m);
});

test("parallel: false keeps a rubric rule in the sequential lane", () => {
  const dir = fixtureRepo([
    "checks:",
    ...rule("suite", "sleep 0.5"),
    ...judged("comments", [ "    parallel: false" ])
  ]);
  const { status, stdout, elapsed } = runFull(dir, { PATH: `${fakeClaude(0.5)}:${process.env.PATH}` });
  assert.equal(status, 0, stdout);
  assert.doesNotMatch(stdout, /running alongside/);
  assert.ok(elapsed >= 1000, `took ${elapsed}ms; one after the other is 1s+`);
});

// Everything the runner started goes down with it: the sequential rule, a
// rule running alongside, and a judge mid-call.
test("a stopped runner kills every lane and journals the run as killed", async () => {
  const dir = fixtureRepo([
    "checks:",
    ...rule("seq", "sleep 30", [ "    timeout: 60" ]),
    ...rule("side", "sleep 30", [ "    parallel: true", "    timeout: 60" ]),
    ...judged("judge", [ "    timeout: 60" ])
  ]);
  const home = mkdtempSync(join(tmpdir(), "hb-home-"));
  const runner = spawn(process.execPath, [ CLI, "run" ], {
    cwd: dir, env: cliEnv({ HOME: home, PATH: `${fakeClaude(30)}:${process.env.PATH}` }), stdio: [ "ignore", "pipe", "pipe" ]
  });
  const exited = new Promise((resolve) => runner.on("close", resolve));
  for (let i = 0; i < 50 && journal(home).at(-1)?.status !== "running"; i++) await sleep(50);
  await sleep(500);

  const t0 = Date.now();
  runner.kill("SIGTERM");
  assert.equal(await exited, 1);
  assert.ok(Date.now() - t0 < 5000, "nothing was waited out");

  const run = journal(home).at(-1);
  assert.equal(run.status, "killed");
  assert.deepEqual(run.results.map((r) => [ r.id, r.killed === true ]), [ [ "seq", true ], [ "side", true ], [ "judge", true ] ]);
});
