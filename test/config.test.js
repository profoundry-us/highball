import { test } from "node:test";
import assert from "node:assert/strict";
import { commandFor, resolveReporting } from "../lib/config.js";

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

test("resolveReporting: env vars win, credentials file is the fallback", () => {
  const config = { project: "demo", reporting: { url: "http://localhost:3600" } };
  const credentials = { "http://localhost:3600": { demo: "hb_from_file" } };

  assert.deepEqual(resolveReporting(config, {}, credentials), {
    url: "http://localhost:3600",
    token: "hb_from_file"
  });
  assert.deepEqual(
    resolveReporting(config, { HIGHBALL_URL: "http://other:1", HIGHBALL_TOKEN: "hb_env" }, credentials),
    { url: "http://other:1", token: "hb_env" }
  );
});

test("resolveReporting yields nulls when nothing is configured", () => {
  assert.deepEqual(resolveReporting({ project: "demo" }, {}, {}), {
    url: null,
    token: null
  });
});
