import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMEOUTS, commandFor, loadConfig, timeoutFor } from "../lib/config.js";

test("commandFor refuses to shell out for a rubric rule", () => {
  const rule = { rubric: ".highball/packs/rails/rubrics/architecture.md" };
  const config = { exec: { via: "docker compose exec -T app" } };

  // The judge needs the host's `claude` CLI, so it must never be wrapped into
  // a container by exec.via — that decision is structural, not per-rule.
  assert.equal(commandFor(rule, config), null);
});

test("commandFor leaves rules untouched when no exec context is declared", () => {
  const rule = { run: "bundle exec rspec spec" };
  assert.equal(commandFor(rule, {}), "bundle exec rspec spec");
});

test("commandFor wraps rules in the declared exec context", () => {
  const rule = { run: ".highball/bin/check-comments --changed-only" };
  const config = { exec: { via: "docker compose exec -T app" } };
  assert.equal(
    commandFor(rule, config),
    "docker compose exec -T app .highball/bin/check-comments --changed-only"
  );
});

test("commandFor honors a rule's host opt-out", () => {
  const rule = { run: "node --check playback/web/maps.js", exec: "host" };
  const config = { exec: { via: "docker compose exec -T mud" } };
  assert.equal(commandFor(rule, config), "node --check playback/web/maps.js");
});



// --- timeouts ---

test("every rule gets the budget for its kind unless it names its own", () => {
  assert.deepEqual(DEFAULT_TIMEOUTS, { fast: 8, full: 60, judge: 300 });
  assert.equal(timeoutFor({ run: "x", fast: true }, {}), 8_000);
  assert.equal(timeoutFor({ run: "x" }, {}), 60_000);
  assert.equal(timeoutFor({ rubric: "r.md" }, {}), 300_000);
  assert.equal(timeoutFor({ run: "x", fast: true, timeout: 45 }, {}), 45_000);
  // A repo raises one kind without disturbing the others.
  const config = { timeouts: { full: 600 } };
  assert.equal(timeoutFor({ run: "x" }, config), 600_000);
  assert.equal(timeoutFor({ run: "x", fast: true }, config), 8_000);
});

function repoWith(yaml) {
  const dir = mkdtempSync(join(tmpdir(), "hb-config-"));
  mkdirSync(join(dir, ".highball"));
  writeFileSync(join(dir, ".highball", "checks.yml"), yaml);
  return dir;
}

const BASE = "version: 1\nproject: p\nchecks:\n  - id: a\n    name: A\n    run: \"true\"\n";

test("a budget that isn't a positive number of seconds is an error, not a shrug", () => {
  assert.throws(() => loadConfig(repoWith(BASE + "timeouts:\n  fast: 0\n")), /`timeouts\.fast:` must be a positive number/);
  assert.throws(() => loadConfig(repoWith(BASE + "timeouts:\n  fast: \"8\"\n")), /`timeouts\.fast:` must be a positive number/);
  assert.throws(() => loadConfig(repoWith(BASE + "timeouts:\n  slow: 8\n")), /`timeouts\.slow` is not a thing/);
  assert.throws(() => loadConfig(repoWith(BASE + "timeouts: 8\n")), /`timeouts:` must be a block/);
  assert.throws(
    () => loadConfig(repoWith(BASE + "    timeout: never\n")),
    /rule `a` has `timeout:` must be a positive number/
  );
  assert.doesNotThrow(() => loadConfig(repoWith(BASE + "    timeout: 2.5\ntimeouts:\n  full: 90\n  judge: 600\n")));
});


// --- checks.local.yml, the per-checkout overlay ---

import { LOCAL_CONFIG_PATH, execContext } from "../lib/config.js";

function repoWithLocal(yaml, local) {
  const dir = repoWith(yaml);
  writeFileSync(join(dir, ".highball", "checks.local.yml"), local);
  return dir;
}

const NO_ENV = {};

test("checks.local.yml overrides exec, merges timeouts per field, and replaces reporting whole", () => {
  const committed = BASE +
    "exec:\n  via: bundle exec\n" +
    "timeouts:\n  fast: 4\n  full: 90\n" +
    "reporting:\n  posthog:\n    host: https://eu.i.posthog.com\n    project_key: phc_team\n";
  const config = loadConfig(repoWithLocal(committed,
    "exec:\n  via: docker compose exec -T app\n" +
    "timeouts:\n  full: 600\n" +
    "reporting:\n  posthog:\n    project_key: phc_mine\n"));

  assert.equal(commandFor({ run: "rspec" }, config, NO_ENV), "docker compose exec -T app rspec");
  assert.deepEqual(execContext(config, NO_ENV), { via: "docker compose exec -T app", source: LOCAL_CONFIG_PATH });
  // Per-field: the team's fast budget survives a local full budget.
  assert.equal(timeoutFor({ run: "x", fast: true }, config), 4_000);
  assert.equal(timeoutFor({ run: "x" }, config), 600_000);
  // Whole-block: the team's host is gone along with its key.
  assert.deepEqual(config.reporting, { posthog: { project_key: "phc_mine" } });
  assert.deepEqual(config.local, [ "exec", "timeouts", "reporting" ]);
});

test("a local `exec: { via: null }` turns a committed wrapper off", () => {
  const config = loadConfig(repoWithLocal(BASE + "exec:\n  via: docker compose exec -T app\n", "exec:\n  via: null\n"));
  assert.equal(commandFor({ run: "rspec" }, config, NO_ENV), "rspec");
  assert.deepEqual(execContext(config, NO_ENV), { via: null, source: null });
});

test("without a local file the committed wrapper is the source, and none is no source", () => {
  const wrapped = loadConfig(repoWith(BASE + "exec:\n  via: docker compose exec -T app\n"));
  assert.deepEqual(execContext(wrapped, NO_ENV), { via: "docker compose exec -T app", source: ".highball/checks.yml" });
  assert.equal(wrapped.local, undefined);
  assert.deepEqual(execContext(loadConfig(repoWith(BASE)), NO_ENV), { via: null, source: null });
});

test("HIGHBALL_EXEC_VIA wins over both files, and an empty one is unset", () => {
  const config = loadConfig(repoWithLocal(BASE + "exec:\n  via: committed\n", "exec:\n  via: local\n"));
  assert.deepEqual(execContext(config, { HIGHBALL_EXEC_VIA: "sh -c" }), { via: "sh -c", source: "HIGHBALL_EXEC_VIA" });
  assert.equal(commandFor({ run: "true" }, config, { HIGHBALL_EXEC_VIA: "sh -c" }), "sh -c true");
  assert.equal(commandFor({ run: "true", exec: "host" }, config, { HIGHBALL_EXEC_VIA: "sh -c" }), "true");
  assert.equal(execContext(config, { HIGHBALL_EXEC_VIA: "  " }).via, "local");
});

test("an empty or absent checks.local.yml changes nothing", () => {
  const plain = loadConfig(repoWith(BASE + "exec:\n  via: committed\n"));
  const empty = loadConfig(repoWithLocal(BASE + "exec:\n  via: committed\n", "# nothing yet\n"));
  assert.deepEqual(empty, plain);
});

// The file exists to change how this checkout runs; a key it can't honour
// must say so, not sit there looking like it worked.
test("checks.local.yml rejects keys that aren't the checkout's to set", () => {
  assert.throws(() => loadConfig(repoWithLocal(BASE, "checks:\n  - id: b\n    run: \"true\"\n")),
    /checks\.local\.yml: `checks:` can't be set locally — only exec, timeouts, reporting can/);
  assert.throws(() => loadConfig(repoWithLocal(BASE, "enabled: false\n")), /`enabled:` can't be set locally/);
  assert.throws(() => loadConfig(repoWithLocal(BASE, "exce:\n  via: x\n")), /`exce:` can't be set locally/);
  assert.throws(() => loadConfig(repoWithLocal(BASE, "- exec\n")), /must be a YAML block/);
  assert.throws(() => loadConfig(repoWithLocal(BASE, "exec: docker compose exec -T app\n")), /`exec:` must be a block with `via:`/);
  assert.throws(() => loadConfig(repoWithLocal(BASE, "timeouts:\n  full: 0\n")),
    /checks\.local\.yml: `timeouts\.full:` must be a positive number/);
  assert.throws(() => loadConfig(repoWithLocal(BASE, "timeouts:\n  slow: 5\n")), /checks\.local\.yml: `timeouts\.slow` is not a thing/);
});
