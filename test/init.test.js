import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEnv } from "./helpers.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));

function runInit(dir) {
  return execFileSync(process.execPath, [ CLI, "init" ], {
    cwd: dir, encoding: "utf8", env: cliEnv(), stdio: [ "ignore", "pipe", "pipe" ]
  });
}

const settings = (dir) => JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));

const checks = (rules) => [
  "version: 1",
  "project: init-fixture",
  "checks:",
  ...rules.flatMap((rule) => [
    `  - id: ${rule.id}`,
    `    name: ${rule.id}`,
    '    run: "true"',
    ...(rule.fast ? [ "    fast: true" ] : [])
  ]),
  ""
].join("\n");

// The hooks call the installed package directly: npx on top of a local
// install spends ~180ms per call resolving to the same file, on every
// agent tool call.
test("init scaffolds hooks that run the local install, not npx", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-init-"));
  assert.match(runInit(dir), /created \.claude\/settings\.json \(fast checks on edit/);

  const { hooks } = settings(dir);
  const commands = [ ...hooks.PostToolUse, ...hooks.Stop ].flatMap((entry) => entry.hooks.map((h) => h.command));
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.match(command, /^node node_modules\/@profoundry-us\/highball\/bin\/highball\.js run/);
    assert.doesNotMatch(command, /npx/);
    assert.match(command, /--if-changed/);
  }
  assert.match(hooks.PostToolUse[0].hooks[0].command, /--fast/);
  assert.equal(hooks.PostToolUse[0].matcher, "Write|Edit|Bash");
});

// A fast hook in a repo with nothing fast to run is pure overhead: node
// startup and a git status after every tool call, for an empty run.
test("init leaves out the fast hook when an existing checks.yml has no fast rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-init-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), checks([ { id: "unit" } ]));

  const out = runInit(dir);
  assert.match(out, /Stop hook only/);
  assert.match(out, /created \.claude\/settings\.json \(full suite at turn end\)/);

  const { hooks } = settings(dir);
  assert.equal(hooks.PostToolUse, undefined);
  assert.equal(hooks.Stop.length, 1);
});

test("init keeps the fast hook when an existing checks.yml has a fast rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-init-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), checks([ { id: "unit" }, { id: "lint", fast: true } ]));

  runInit(dir);
  const { hooks } = settings(dir);
  assert.equal(hooks.PostToolUse.length, 1);
  assert.equal(hooks.Stop.length, 1);
});

// A config that run will reject must not stop init from scaffolding —
// unknown counts as "keep the fast hook", never as a crash.
test("init treats an unreadable checks.yml as having fast rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-init-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), "checks: [\n");

  runInit(dir);
  assert.equal(settings(dir).hooks.PostToolUse.length, 1);
});

// checks.local.yml is gitignored for the same reason `disabled` is: a
// per-machine Docker wrapper landing in a commit breaks every teammate's
// hooks, which is the exact incident the overlay exists to prevent.
test("init gitignores checks.local.yml, and adds the line to an older install's .gitignore", () => {
  const fresh = mkdtempSync(join(tmpdir(), "hb-init-"));
  runInit(fresh);
  const ignored = readFileSync(join(fresh, ".highball", ".gitignore"), "utf8").split("\n");
  assert.ok(ignored.includes("disabled"));
  assert.ok(ignored.includes("checks.local.yml"));

  const older = mkdtempSync(join(tmpdir(), "hb-init-"));
  mkdirSync(join(older, ".highball"));
  writeFileSync(join(older, ".highball", ".gitignore"), "# mine\ndisabled\n");
  assert.match(runInit(older), /added checks\.local\.yml to \.highball\/\.gitignore/);
  const updated = readFileSync(join(older, ".highball", ".gitignore"), "utf8");
  assert.match(updated, /^# mine\ndisabled\n/);
  assert.ok(updated.split("\n").includes("checks.local.yml"));

  assert.match(runInit(older), /kept existing \.highball\/\.gitignore/);
});
