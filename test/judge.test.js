import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  parseRubric, globToRegExp, selectFiles, buildBundles, numberLines, withinChanges,
  extractVerdict, judge
} from "../lib/judge.js";
import { createPool } from "../lib/pool.js";

const RUBRIC = `---
include: "**/*.rb"
exclude: [db/, config/]
model: claude-test-model
---
Comments must earn their place.
`;

const verdict = (status, offenses = []) => ({
  status: 0, stdout: JSON.stringify({ result: JSON.stringify({ status, offenses }) })
});

// A judge run with everything the filesystem and CLI would provide stubbed,
// so the contract is exercised without git or a paid model call. `invoke`
// stands in for one headless Claude call.
async function stubbedJudge(overrides = {}) {
  const calls = [];
  const defaults = {
    rubricPath: "rubrics/comment-quality.md",
    changed: "app/models/user.rb\napp/models/post.rb",
    timeoutMs: 5000,
    exists: () => true,
    read: (path) => (path.endsWith(".md") ? RUBRIC : `# source of ${path}\n`),
    invoke: async (call) => {
      calls.push(call);
      return verdict("passed");
    }
  };
  const merged = { ...defaults, ...overrides };
  if (overrides.invoke) {
    merged.invoke = async (call) => {
      calls.push(call);
      return overrides.invoke(call);
    };
  }
  return { calls, result: await judge(merged) };
}

test("parseRubric splits front matter from prose, and tolerates its absence", () => {
  const { meta, body } = parseRubric(RUBRIC);
  assert.equal(meta.include, "**/*.rb");
  assert.deepEqual(meta.exclude, [ "db/", "config/" ]);
  assert.equal(meta.model, "claude-test-model");
  assert.equal(body.trim(), "Comments must earn their place.");

  assert.deepEqual(parseRubric("just prose"), { meta: {}, body: "just prose" });
});

test("globToRegExp: ** spans directories, * stops at one", () => {
  const rb = globToRegExp("**/*.rb");
  assert.ok(rb.test("app/models/user.rb"));
  assert.ok(rb.test("user.rb"));
  assert.ok(!rb.test("app/models/user.rbx"));
  assert.ok(!globToRegExp("app/*.rb").test("app/models/user.rb"));
  assert.ok(globToRegExp("**/config/**").test("engines/coaching/config/routes.rb"));
  assert.ok(globToRegExp("**/config/**").test("config/routes.rb"));
});

test("selectFiles applies include, exclude, dedupe, and existence", () => {
  const meta = { include: "**/*.rb", exclude: [ "db/", "config/" ] };
  const changed = [
    "app/models/user.rb",
    "app/models/user.rb", // duplicate
    "db/schema.rb", // excluded prefix
    "config/routes.rb", // excluded prefix
    "README.md", // not included
    "app/models/gone.rb" // deleted on disk
  ].join("\n");
  const files = selectFiles(changed, meta, (path) => path !== "app/models/gone.rb");
  assert.deepEqual(files, [ "app/models/user.rb" ]);
});

test("selectFiles defaults to every changed file when the rubric is silent", () => {
  assert.deepEqual(selectFiles("a.rb\nb.py\n", {}, () => true), [ "a.rb", "b.py" ]);
});

// A plain exclude stayed a prefix, so `config/` never reached an engine's
// nested config. A glob entry does; a plain one still means what it meant.
test("exclude entries with a glob character are globs; plain entries stay prefixes", () => {
  const changed = "config/routes.rb\nengines/coaching/config/routes.rb\napp/config_loader.rb\napp/models/user.rb";
  assert.deepEqual(
    selectFiles(changed, { exclude: [ "**/config/**" ] }, () => true),
    [ "app/config_loader.rb", "app/models/user.rb" ]
  );
  assert.deepEqual(
    selectFiles(changed, { exclude: [ "config/" ] }, () => true),
    [ "engines/coaching/config/routes.rb", "app/config_loader.rb", "app/models/user.rb" ]
  );
});

test("numberLines numbers every line, padded, without inventing a trailing one", () => {
  assert.equal(numberLines("a\nb\n"), "1| a\n2| b\n");
  const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
  assert.match(numberLines(ten), /^ 1\| l1\n/);
  assert.match(numberLines(ten), /\n10\| l10\n$/);
});

test("buildBundles splits instead of truncating, and gives an oversize file its own bundle", () => {
  const files = [ "a.rb", "b.rb", "c.rb", "huge.rb", "d.rb" ];
  const read = (file) => (file === "huge.rb" ? "x\n".repeat(200) : "line\n".repeat(5));
  const { bundles, oversize } = buildBundles(files, 150, read);

  assert.deepEqual(bundles.flatMap((bundle) => bundle.files), files, "every file, in order, exactly once");
  assert.ok(bundles.length > 1);
  assert.deepEqual(bundles.find((bundle) => bundle.files.includes("huge.rb")).files, [ "huge.rb" ]);
  assert.equal(oversize, 1);
  for (const bundle of bundles.filter((b) => !b.files.includes("huge.rb"))) {
    assert.ok(Buffer.byteLength(bundle.text) <= 150, "ordinary bundles stay under the cap");
  }
});

test("extractVerdict digs the JSON out of a chatty response", () => {
  const wrap = (result) => JSON.stringify({ result });
  assert.deepEqual(
    extractVerdict(wrap('```json\n{"status":"failed","offenses":[{"file":"a.rb","line":3,"message":"x"}]}\n```')),
    { status: "failed", offenses: [ { file: "a.rb", line: 3, message: "x" } ] }
  );
  assert.deepEqual(
    extractVerdict(wrap('Sure! {"status":"passed","offenses":[]} Hope that helps.')),
    { status: "passed", offenses: [] }
  );
  assert.throws(() => extractVerdict(wrap("no json at all")), /no JSON verdict/);
});

test("judge passes without calling the model when no file matches", async () => {
  const { calls, result } = await stubbedJudge({ changed: "README.md\napp/main.py" });
  assert.equal(result.passed, true);
  assert.equal(calls.length, 0, "must not pay for a model call with no evidence");
  assert.match(result.output, /0 file\(s\)/);
});

test("judge honors the rubric's model and numbers the evidence", async () => {
  const { calls, result } = await stubbedJudge();
  assert.equal(result.passed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "claude-test-model");
  assert.match(calls[0].prompt, /===== app\/models\/user\.rb =====\n1\| # source of app\/models\/user\.rb\n/);
  assert.match(calls[0].prompt, /Every line is numbered; cite those\nnumbers/);
});

test("judge reports offenses in the same shape as the deterministic checks", async () => {
  const { result } = await stubbedJudge({
    invoke: () => verdict("failed", [ { file: "app/models/user.rb", line: 12, message: "restates the code" } ])
  });
  assert.equal(result.passed, false);
  assert.match(result.output, /app\/models\/user\.rb:12: restates the code/);
  assert.match(result.output, /1 offense\(s\)/);
});

// The webtree run: 25 changed files, 9 judged, and every brand-new file —
// listed last — skipped while the rule passed. Now every file is judged,
// across as many calls as it takes, and the verdicts merge.
test("judge judges every changed file across several calls and merges their offenses", async () => {
  const changed = Array.from({ length: 25 }, (_, i) => `app/f${String(i).padStart(2, "0")}.rb`).join("\n");
  const rubric = RUBRIC.replace("model:", "max_bytes: 400\nmodel:");
  const { calls, result } = await stubbedJudge({
    changed,
    read: (path) => (path.endsWith(".md") ? rubric : "code\n".repeat(20)),
    invoke: ({ prompt }) => {
      const files = [ ...prompt.matchAll(/===== (\S+) =====/g) ].map((m) => m[1]);
      return verdict("failed", files.filter((f) => f.endsWith("0.rb")).map((file) => ({ file, line: 1, message: "bad" })));
    }
  });

  const judged = calls.flatMap(({ prompt }) => [ ...prompt.matchAll(/===== (\S+) =====/g) ].map((m) => m[1]));
  assert.equal(judged.length, 25);
  assert.equal(new Set(judged).size, 25, "every file, once");
  assert.ok(judged.includes("app/f24.rb"), "the last file — where untracked files land — is judged");
  assert.ok(calls.length > 1);
  assert.match(result.output, new RegExp(`AI-judged 25 file\\(s\\) in ${calls.length} parts against`));
  assert.match(result.output, /app\/f00\.rb:1: bad/);
  assert.match(result.output, /app\/f20\.rb:1: bad/);
  assert.match(result.output, /3 offense\(s\)/);
  assert.doesNotMatch(result.output, /skipped/);
});

test("judge runs its calls concurrently, within the pool it's given", async () => {
  const changed = Array.from({ length: 4 }, (_, i) => `app/f${i}.rb`).join("\n");
  const rubric = RUBRIC.replace("model:", "max_bytes: 10\nmodel:");
  const read = (path) => (path.endsWith(".md") ? rubric : "code\n");
  let inFlight = 0;
  let most = 0;
  const invoke = async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await sleep(30);
    inFlight -= 1;
    return verdict("passed");
  };

  await stubbedJudge({ changed, read, invoke });
  assert.equal(most, 4, "unbounded: all four at once");

  most = 0;
  await stubbedJudge({ changed, read, invoke, pool: createPool(2) });
  assert.equal(most, 2, "bounded by the shared pool");
});

test("one budget covers the whole rule: an unfinished part times the rule out", async () => {
  const changed = "app/a.rb\napp/b.rb";
  const rubric = RUBRIC.replace("model:", "max_bytes: 10\nmodel:");
  const { calls, result } = await stubbedJudge({
    changed,
    timeoutMs: 1000,
    read: (path) => (path.endsWith(".md") ? rubric : "code\n"),
    invoke: ({ prompt }) => (prompt.includes("app/b.rb")
      ? { status: null, stdout: "", stderr: "", timedOut: true }
      : verdict("failed", [ { file: "app/a.rb", line: 1, message: "found before the budget ran out" } ]))
  });
  assert.ok(calls.every((call) => call.timeoutMs <= 1000));
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, true);
  assert.match(result.output, /AI judge gave no verdict within 1s \(1 of 2 parts unfinished\)/);
  assert.match(result.output, /app\/a\.rb:1: found before the budget ran out/);
});

test("judge fails with a plain explanation when the claude CLI is missing", async () => {
  const { result } = await stubbedJudge({ invoke: () => ({ error: { code: "ENOENT" }, status: null }) });
  assert.equal(result.passed, false);
  assert.match(result.output, /claude` CLI on PATH/);
});

test("judge fails, rather than throwing, on a missing rubric or an unknown scope", async () => {
  assert.match((await stubbedJudge({ exists: () => false })).result.output, /rubric not found/);
  const { calls, result } = await stubbedJudge({
    read: (path) => (path.endsWith(".md") ? RUBRIC.replace("model:", "scope: lines\nmodel:") : "x\n")
  });
  assert.equal(result.passed, false);
  assert.match(result.output, /`scope: lines` isn't a scope — use `files` \(the default\) or `changed`/);
  assert.equal(calls.length, 0);
});

// --- scope: changed ---

const SCOPED = RUBRIC.replace("model:", "scope: changed\nmodel:");
const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("scope: changed labels each file with its changed lines and tells the judge to stay inside them", async () => {
  const { calls } = await stubbedJudge({
    changed: "app/models/user.rb\napp/models/post.rb\napp/models/new.rb",
    read: (path) => (path.endsWith(".md") ? SCOPED : tenLines),
    changedLines: () => new Map([
      [ "app/models/user.rb", [ [ 3, 4 ], [ 9, 9 ] ] ],
      [ "app/models/new.rb", "all" ]
    ])
  });
  const { prompt } = calls[0];
  assert.match(prompt, /===== app\/models\/user\.rb \(changed lines: 3-4, 9\) =====/);
  assert.match(prompt, /===== app\/models\/post\.rb \(no changed lines\) =====/);
  assert.match(prompt, /===== app\/models\/new\.rb \(new file: every line is changed\) =====/);
  assert.match(prompt, /Report ONLY\noffenses on those lines/);
});

// The stale comment that predated the branch and still failed the turn: an
// offense outside the changed lines is dropped by the runner, not merely
// discouraged in the prompt.
test("scope: changed drops offenses outside the changed lines, and says how many", async () => {
  const { result } = await stubbedJudge({
    changed: "app/models/user.rb\napp/models/new.rb",
    read: (path) => (path.endsWith(".md") ? SCOPED : tenLines),
    changedLines: () => new Map([ [ "app/models/user.rb", [ [ 3, 4 ] ] ], [ "app/models/new.rb", "all" ] ]),
    invoke: () => verdict("failed", [
      { file: "app/models/user.rb", line: 1, message: "stale comment from before the branch" },
      { file: "app/models/user.rb", line: 4, message: "new comment restates the code" },
      { file: "app/models/new.rb", line: 7, message: "in a new file, so in scope" },
      { file: "./app/models/user.rb", line: 9, message: "also outside" }
    ])
  });
  assert.equal(result.passed, false);
  assert.match(result.output, /AI-judged 2 file\(s\) \(changed lines only\) against/);
  assert.match(result.output, /app\/models\/user\.rb:4: new comment restates the code/);
  assert.match(result.output, /app\/models\/new\.rb:7: in a new file/);
  assert.doesNotMatch(result.output, /stale comment/);
  assert.match(result.output, /2 offense\(s\) outside the changed lines ignored/);
  assert.match(result.output, /\n2 offense\(s\)$/);
});

test("scope: changed passes when every offense is outside the changed lines", async () => {
  const { result } = await stubbedJudge({
    read: (path) => (path.endsWith(".md") ? SCOPED : tenLines),
    changedLines: () => new Map([ [ "app/models/user.rb", [ [ 3, 3 ] ] ] ]),
    invoke: () => verdict("failed", [ { file: "app/models/user.rb", line: 8, message: "old" } ])
  });
  assert.equal(result.passed, true);
  assert.match(result.output, /1 offense\(s\) outside the changed lines ignored\n0 offense\(s\)/);
});

test("withinChanges keeps what it can't place", () => {
  const rangesFor = (file) => ({ "a.rb": [ [ 2, 3 ] ], "n.rb": "all" })[file];
  assert.equal(withinChanges({ file: "a.rb", line: 2 }, rangesFor), true);
  assert.equal(withinChanges({ file: "a.rb", line: 5 }, rangesFor), false);
  assert.equal(withinChanges({ file: "n.rb", line: 500 }, rangesFor), true);
  assert.equal(withinChanges({ file: "elsewhere.rb", line: 5 }, rangesFor), true, "unknown file");
  assert.equal(withinChanges({ file: "a.rb", line: "top" }, rangesFor), true, "unplaceable line");
});

test("scope: files (the default) never filters, and never asks for changed lines", async () => {
  let asked = false;
  const { result } = await stubbedJudge({
    changedLines: () => { asked = true; return new Map(); },
    invoke: () => verdict("failed", [ { file: "app/models/user.rb", line: 1, message: "old but in scope" } ])
  });
  assert.equal(asked, false, "the git diff is only paid for when a rubric needs it");
  assert.match(result.output, /app\/models\/user\.rb:1: old but in scope/);
});
