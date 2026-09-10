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
