import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRubric, globToRegExp, selectFiles, buildBundle, extractVerdict, judge
} from "../lib/judge.js";

const RUBRIC = `---
include: "**/*.rb"
exclude: [db/, config/]
model: claude-test-model
---
Comments must earn their place.
`;

// A judge run with everything the filesystem and CLI would provide stubbed,
// so the contract is exercised without Ruby, git, or a paid model call.
function stubbedJudge(overrides = {}) {
  const calls = [];
  const defaults = {
    rubricPath: "rubrics/comment-quality.md",
    changed: "app/models/user.rb\napp/models/post.rb",
    exists: () => true,
    read: (path) => (path.endsWith(".md") ? RUBRIC : `# source of ${path}\n`),
    spawn: (bin, args, options) => {
      calls.push({ bin, args, options });
      return {
        status: 0,
        stdout: JSON.stringify({ result: '{"status":"passed","offenses":[]}' })
      };
    }
  };
  return { calls, result: judge({ ...defaults, ...overrides }) };
}

test("parseRubric splits front matter from prose, and tolerates its absence", () => {
  const { meta, body } = parseRubric(RUBRIC);
  assert.equal(meta.include, "**/*.rb");
  assert.deepEqual(meta.exclude, [ "db/", "config/" ]);
  assert.equal(body.trim(), "Comments must earn their place.");

  const plain = parseRubric("Just prose, no fence.\n");
  assert.deepEqual(plain.meta, {});
  assert.equal(plain.body, "Just prose, no fence.\n");
});

test("globToRegExp: ** spans directories, * stops at one", () => {
  assert.ok(globToRegExp("**/*.rb").test("app/models/user.rb"));
  assert.ok(globToRegExp("**/*.rb").test("user.rb"), "**/ must match zero directories");
  assert.ok(!globToRegExp("**/*.rb").test("app/main.py"));

  assert.ok(globToRegExp("*.rb").test("user.rb"));
  assert.ok(!globToRegExp("*.rb").test("app/user.rb"), "* must not cross a slash");

  // Dots are literal, not "any character" — else *.rb would match "userXrb".
  assert.ok(!globToRegExp("*.rb").test("userXrb"));
});

test("selectFiles applies include, exclude, dedupe, and existence", () => {
  const meta = { include: "**/*.rb", exclude: [ "db/", "config/" ] };
  const changed = [
    "app/models/user.rb",
    "app/models/user.rb", // duplicate
    "db/schema.rb", // excluded prefix
    "config/routes.rb", // excluded prefix
    "app/main.py", // wrong extension
    "app/models/gone.rb" // does not exist
  ].join("\n");

  const files = selectFiles(changed, meta, (path) => path !== "app/models/gone.rb");
  assert.deepEqual(files, [ "app/models/user.rb" ]);
});

test("selectFiles defaults to every changed file when the rubric is silent", () => {
  const files = selectFiles("a.rb\nb.py\n", {}, () => true);
  assert.deepEqual(files, [ "a.rb", "b.py" ]);
});

test("buildBundle caps the evidence and reports what it dropped", () => {
  const files = [ "a.rb", "b.rb", "c.rb" ];
  const read = () => "x".repeat(40);

  const { included, skipped, bundle } = buildBundle(files, 120, read);
  assert.ok(included.length < files.length, "expected the cap to bite");
  assert.equal(skipped, files.length - included.length);
  assert.ok(bundle.includes("===== a.rb ====="));
});

test("extractVerdict digs the JSON out of a chatty response", () => {
  const wrap = (text) => JSON.stringify({ result: text });

  assert.deepEqual(
    extractVerdict(wrap('{"status":"passed","offenses":[]}')),
    { status: "passed", offenses: [] }
  );
  assert.deepEqual(
    extractVerdict(wrap('```json\n{"status":"passed","offenses":[]}\n```')),
    { status: "passed", offenses: [] }
  );
  assert.deepEqual(
    extractVerdict(wrap('Sure! {"status":"passed","offenses":[]} Hope that helps.')),
    { status: "passed", offenses: [] }
  );
  assert.throws(() => extractVerdict(wrap("no json at all")), /no JSON verdict/);
});

test("judge passes without spawning anything when no file matches", () => {
  const { calls, result } = stubbedJudge({ changed: "README.md\napp/main.py" });

  assert.equal(result.passed, true);
  assert.equal(calls.length, 0, "must not pay for a model call with no evidence");
  assert.match(result.output, /0 file\(s\)/);
});

test("judge honors the rubric's model and sets the recursion guard", () => {
  const { calls, result } = stubbedJudge();

  assert.equal(result.passed, true);
  assert.deepEqual(calls[0].args, [
    "-p", "--model", "claude-test-model", "--output-format", "json"
  ]);
  assert.equal(calls[0].options.env.HIGHBALL_JUDGE, "1");
});

test("judge reports offenses in the same shape as the deterministic checks", () => {
  const { result } = stubbedJudge({
    spawn: () => ({
      status: 0,
      stdout: JSON.stringify({
        result: JSON.stringify({
          status: "failed",
          offenses: [ { file: "app/models/user.rb", line: 12, message: "restates the code" } ]
        })
      })
    })
  });

  assert.equal(result.passed, false);
  assert.match(result.output, /app\/models\/user\.rb:12: restates the code/);
  assert.match(result.output, /1 offense\(s\)/);
});

test("judge fails with a plain explanation when the claude CLI is missing", () => {
  const { result } = stubbedJudge({
    spawn: () => ({ error: { code: "ENOENT" }, status: null })
  });

  assert.equal(result.passed, false);
  assert.match(result.output, /claude` CLI on PATH/);
});

test("judge fails, rather than throwing, on a missing rubric", () => {
  const { result } = stubbedJudge({ exists: () => false });

  assert.equal(result.passed, false);
  assert.match(result.output, /rubric not found/);
});
