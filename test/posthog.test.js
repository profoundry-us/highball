import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvents, RUN_EVENT, CHECK_EVENT } from "../lib/posthog.js";
import { resolvePosthog } from "../lib/config.js";

const STARTED = new Date("2026-08-31T12:00:00.000Z");

function fixture(overrides = {}) {
  return {
    project: "webtree",
    branch: "main",
    commitSha: "abc123",
    startedAt: STARTED,
    durationMs: 4321,
    version: "0.5.0",
    distinctId: "topher@profoundry.us",
    hook: { session_id: "sess-1" },
    fastOnly: false,
    results: [
      { rule: { id: "rubocop", name: "RuboCop", run: "bundle exec rubocop" },
        passed: true, todo: false, durationMs: 2700, output: "" },
      { rule: { id: "rspec", name: "RSpec", run: "bundle exec rspec" },
        passed: false, todo: false, durationMs: 18_000,
        output: "\n  1) Thing fails\n     expected true\n" },
      { rule: { id: "e2e", name: "Playwright" },
        passed: true, todo: true, durationMs: null, output: "" }
    ],
    ...overrides
  };
}

test("a run produces one run event plus one event per rule", () => {
  const events = buildEvents(fixture());

  assert.equal(events.length, 4);
  assert.equal(events[0].event, RUN_EVENT);
  assert.deepEqual(
    events.slice(1).map((event) => event.event),
    [ CHECK_EVENT, CHECK_EVENT, CHECK_EVENT ]
  );
});

test("the run event carries the counts and both rule lists", () => {
  const { properties } = buildEvents(fixture())[0];

  assert.equal(properties.status, "failed");
  assert.equal(properties.rules_total, 3);
  assert.equal(properties.rules_passed, 1);
  assert.equal(properties.rules_failed, 1);
  assert.equal(properties.rules_todo, 1);

  // rules_run is the denominator: without it, "how often does rspec fail"
  // can't be normalized across runs whose rulesets differ.
  assert.deepEqual(properties.rules_run, [ "rubocop", "rspec", "e2e" ]);
  assert.deepEqual(properties.failed_rules, [ "rspec" ]);
});

test("todo rules count as neither passed nor failed", () => {
  const { properties } = buildEvents(fixture({
    results: [ { rule: { id: "e2e", name: "Playwright" }, passed: true, todo: true,
                 durationMs: null, output: "" } ]
  }))[0];

  // A rule nobody has built yet must not inflate the pass rate — that would
  // make an aspirational ruleset look healthier than a real one.
  assert.equal(properties.rules_passed, 0);
  assert.equal(properties.rules_todo, 1);
  assert.equal(properties.status, "passed");
});

test("check events carry a one-line summary and never the log tail", () => {
  const events = buildEvents(fixture());
  const rspec = events.find((event) => event.properties.rule_id === "rspec");

  assert.equal(rspec.properties.status, "failed");
  assert.equal(rspec.properties.summary, "1) Thing fails");

  // Multi-kilobyte blobs in event properties bloat the column store and slow
  // every query that touches it. The full output lives in the journal.
  for (const event of events) {
    assert.ok(!("log_tail" in event.properties));
    assert.ok(!("output" in event.properties));
    assert.ok((event.properties.summary ?? "").length <= 120);
  }
});

test("passing rules report a null summary rather than an empty string", () => {
  const events = buildEvents(fixture());
  const rubocop = events.find((event) => event.properties.rule_id === "rubocop");

  assert.equal(rubocop.properties.summary, null);
});

test("run context is denormalized onto every check event", () => {
  const events = buildEvents(fixture());

  // PostHog cannot join a check event back to its run, so a breakdown like
  // "failure rate by rule, on this branch only" needs the context inline.
  for (const event of events) {
    assert.equal(event.properties.project, "webtree");
    assert.equal(event.properties.branch, "main");
    assert.equal(event.properties.commit, "abc123");
    assert.equal(event.properties.trigger, "stop");
    assert.equal(event.properties.session_key, "sess-1");
    assert.equal(event.properties.runner_version, "0.5.0");
    assert.equal(event.distinct_id, "topher@profoundry.us");
    assert.equal(event.timestamp, "2026-08-31T12:00:00.000Z");
  }
});

test("the fast path is labelled edit, the turn-end path stop", () => {
  assert.equal(buildEvents(fixture({ fastOnly: true }))[0].properties.trigger, "edit");
  assert.equal(buildEvents(fixture({ fastOnly: false }))[0].properties.trigger, "stop");
});

test("a run outside an agent session still reports, as manual", () => {
  const events = buildEvents(fixture({ hook: {} }));

  assert.equal(events[0].properties.agent, "manual");
  assert.match(events[0].properties.session_key, /^manual-/);
});

test("resolvePosthog stays off until a key is configured", () => {
  assert.deepEqual(resolvePosthog({ project: "demo" }, {}), { host: null, key: null });
  assert.deepEqual(
    resolvePosthog({ project: "demo", reporting: { url: "http://localhost:3600" } }, {}),
    { host: null, key: null }
  );
});

test("resolvePosthog defaults the host and lets env override committed config", () => {
  const config = { reporting: { posthog: { project_key: "phc_committed" } } };

  // The key is write-only by design, so unlike the dashboard token it is
  // committed config — there is no credentials file to consult.
  assert.deepEqual(resolvePosthog(config, {}), {
    host: "https://us.i.posthog.com",
    key: "phc_committed"
  });

  assert.deepEqual(
    resolvePosthog(config, {
      HIGHBALL_POSTHOG_KEY: "phc_env",
      HIGHBALL_POSTHOG_HOST: "https://eu.i.posthog.com"
    }),
    { host: "https://eu.i.posthog.com", key: "phc_env" }
  );
});

test("resolvePosthog honors a self-hosted host from config", () => {
  assert.deepEqual(
    resolvePosthog({
      reporting: { posthog: { host: "https://ph.internal", project_key: "phc_x" } }
    }, {}),
    { host: "https://ph.internal", key: "phc_x" }
  );
});
