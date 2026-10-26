import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SLOWEST_RUNS, findRun, parseRunsArgs, rerunCommand, shortId, slowestRules
} from "../lib/runs.js";

const history = [
  { id: "c7d855aa-0000-4000-8000-000000000001" },
  { id: "4f2a1cbb-0000-4000-8000-000000000002" },
  { id: "4f2a99cc-0000-4000-8000-000000000003" },
  {} // a record from a runner before ids
];

test("parseRunsArgs reads the target and every flag", () => {
  assert.deepEqual(parseRunsArgs([]),
    { target: null, logs: false, fast: false, limit: null, slowest: null });
  assert.deepEqual(parseRunsArgs([ "3", "--logs" ]),
    { target: "3", logs: true, fast: false, limit: null, slowest: null });
  assert.equal(parseRunsArgs([ "--limit=25" ]).limit, 25);
  assert.equal(parseRunsArgs([ "--slowest" ]).slowest, DEFAULT_SLOWEST_RUNS);
  assert.deepEqual(parseRunsArgs([ "--slowest=5", "--fast" ]),
    { target: null, logs: false, fast: true, limit: null, slowest: 5 });
});

// The why-slow skill passes whatever was typed after `--slowest`.
test("parseRunsArgs reads `--slowest N` as a count, and refuses a run beside it", () => {
  assert.deepEqual(parseRunsArgs([ "--slowest", "50", "--fast" ]),
    { target: null, logs: false, fast: true, limit: null, slowest: 50 });
  assert.match(parseRunsArgs([ "--slowest", "0" ]).error, /positive whole number/);
  assert.match(parseRunsArgs([ "--slowest", "c7d855" ]).error, /give it a count, not a run/);
  assert.match(parseRunsArgs([ "--slowest=5", "3" ]).error, /give it a count, not a run/);
});

// A typo'd limit that quietly showed everything would read as a working one.
test("parseRunsArgs refuses bad values and unknown options", () => {
  assert.match(parseRunsArgs([ "--limit=0" ]).error, /positive whole number/);
  assert.match(parseRunsArgs([ "--limit=lots" ]).error, /positive whole number/);
  assert.match(parseRunsArgs([ "--slowest=-2" ]).error, /positive whole number/);
  assert.match(parseRunsArgs([ "--limit", "25" ]).error, /unknown option `--limit`/);
  assert.match(parseRunsArgs([ "--verbose" ]).error, /unknown option/);
});

test("findRun takes a run number, newest first", () => {
  assert.equal(findRun(history, "2").run, history[1]);
  assert.equal(findRun(history, "2").index, 2);
  assert.match(findRun(history, "9").error, /no run #9 \(4 recorded\)/);
});

test("findRun takes an id prefix, and says when one is ambiguous", () => {
  assert.equal(findRun(history, "c7d855").index, 1);
  assert.equal(findRun(history, "C7D8").index, 1, "case doesn't matter");
  assert.equal(findRun(history, "4f2a1c").index, 2);
  assert.match(findRun(history, "4f2a").error, /2 runs have ids starting 4f2a/);
  assert.match(findRun(history, "abcdef").error, /no run with id abcdef/);
});

// Numbers stop at three digits and ids print six wide, so an all-digit id
// is still an id.
test("findRun reads four or more digits as an id, never as a number", () => {
  const numeric = [ { id: "402157ab-0000-4000-8000-000000000000" } ];
  assert.equal(findRun(numeric, "402157").run, numeric[0]);
  assert.match(findRun(numeric, "1000").error, /no run with id 1000/);
  assert.match(findRun(numeric, "0").error, /neither a run number nor a run id/);
  assert.match(findRun(numeric, "latest").error, /neither a run number nor a run id/);
});

test("shortId prints six characters, or a dash for a record with no id", () => {
  assert.equal(shortId(history[0]), "c7d855");
  assert.equal(shortId(history[3]), "-");
});

test("rerunCommand offers a failed rule's command, but not an AI judge's", () => {
  assert.equal(rerunCommand({ command: "npm test" }), "npm test");
  assert.equal(
    rerunCommand({ command: "docker compose exec -T app bundle exec rspec" }),
    "docker compose exec -T app bundle exec rspec",
    "a wrapped rule reruns through its wrapper, as it ran"
  );
  assert.equal(rerunCommand({ command: "judge .highball/rubrics/style.md" }), null);
  assert.equal(rerunCommand({ command: null }), null);
  assert.equal(rerunCommand({}), null, "records from before commands were journaled");
});

const full = (ms, results, status = "passed") => ({ trigger: "stop", status, duration_ms: ms, results });
const rule = (id, ms, extra = {}) => ({ id, name: id, status: "passed", duration_ms: ms, ...extra });

test("slowestRules ranks rules by median time over recent full runs", () => {
  const report = slowestRules([
    full(90_000, [ rule("tests", 82_000), rule("lint", 2_000) ]),
    full(88_000, [ rule("tests", 80_000), rule("lint", 3_000) ]),
    full(95_000, [ rule("tests", 95_000, { status: "failed", timed_out: true }), rule("lint", 1_000) ], "failed"),
    { trigger: "edit", status: "passed", duration_ms: 900, results: [ rule("lint", 900) ] },
    { trigger: "stop", status: "running", duration_ms: 400, results: [ rule("tests", 400) ] }
  ]);
  assert.equal(report.runs, 3, "fast runs and unfinished runs are left out");
  assert.equal(report.run_median_ms, 90_000);
  assert.deepEqual(report.rules.map((r) => r.id), [ "tests", "lint" ]);
  assert.deepEqual(report.rules[0], {
    id: "tests", name: "tests", runs: 3, median_ms: 82_000, max_ms: 95_000,
    share: 82_000 / 90_000, timeouts: 1
  });
});

test("slowestRules looks at fast runs when asked, and only the newest count", () => {
  const history = [
    { trigger: "edit", status: "passed", duration_ms: 1_000, results: [ rule("lint", 1_000) ] },
    { trigger: "edit", status: "passed", duration_ms: 3_000, results: [ rule("lint", 3_000) ] },
    { trigger: "edit", status: "passed", duration_ms: 9_000, results: [ rule("lint", 9_000) ] }
  ];
  const report = slowestRules(history, { count: 2, fast: true });
  assert.equal(report.runs, 2);
  assert.equal(report.rules[0].median_ms, 2_000);
  assert.equal(report.rules[0].max_ms, 3_000);
});

test("slowestRules skips todo rules and rules with no time", () => {
  const report = slowestRules([
    full(5_000, [ rule("later", null, { status: "todo" }), rule("quiet", null), rule("tests", 4_000) ])
  ]);
  assert.deepEqual(report.rules.map((r) => r.id), [ "tests" ]);
  assert.deepEqual(slowestRules([]), { runs: 0, run_median_ms: null, rules: [] });
});
