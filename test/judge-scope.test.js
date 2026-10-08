import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEnv } from "./helpers.js";

const CLI = fileURLToPath(new URL("../bin/highball.js", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e"
};

// A judge that blames line 1 (old code) and line 3 (the edit) of the
// tracked file, and line 2 of the new one, whatever it's shown.
function blamingClaude() {
  const dir = mkdtempSync(join(tmpdir(), "hb-claude-"));
  const verdict = JSON.stringify({
    status: "failed",
    offenses: [
      { file: "app/old.rb", line: 1, message: "stale comment from before the branch" },
      { file: "app/old.rb", line: 3, message: "the edit restates the code" },
      { file: "app/new.rb", line: 2, message: "new file, every line in scope" }
    ]
  });
  writeFileSync(join(dir, "claude"), `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${JSON.stringify({ result: verdict })}'\n`);
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

function fixtureRepo(scope) {
  const dir = mkdtempSync(join(tmpdir(), "hb-scope-"));
  mkdirSync(join(dir, ".highball"));
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, ".highball", "checks.yml"),
    "version: 1\nproject: scope-fixture\nchecks:\n  - id: comments\n    name: Comments (AI)\n    rubric: .highball/r.md\n");
  writeFileSync(join(dir, ".highball", "r.md"), `---\ninclude: "app/**"\nscope: ${scope}\n---\nComments earn their place.\n`);
  writeFileSync(join(dir, "app", "old.rb"), "# a\n# b\n# c\n# d\n");
  execFileSync("git", [ "init", "-q" ], { cwd: dir });
  execFileSync("git", [ "add", "." ], { cwd: dir });
  execFileSync("git", [ "commit", "-q", "-m", "init" ], { cwd: dir, env: { ...process.env, ...GIT_ENV } });
  // The branch's work: line 3 of a tracked file, and a brand-new file.
  writeFileSync(join(dir, "app", "old.rb"), "# a\n# b\n# c, edited\n# d\n");
  writeFileSync(join(dir, "app", "new.rb"), "x\ny\n");
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [ CLI, "run" ], {
  cwd: dir, encoding: "utf8", stdio: [ "ignore", "pipe", "pipe" ],
  env: cliEnv({ HOME: mkdtempSync(join(tmpdir(), "hb-home-")), PATH: `${blamingClaude()}:${process.env.PATH}` })
});

test("scope: changed enforces on the lines git says this branch touched, through the real CLI", () => {
  const { status, stderr } = run(fixtureRepo("changed"));
  assert.equal(status, 2);
  assert.match(stderr, /AI-judged 2 file\(s\) \(changed lines only\)/);
  assert.match(stderr, /app\/old\.rb:3: the edit restates the code/);
  assert.match(stderr, /app\/new\.rb:2: new file, every line in scope/);
  assert.doesNotMatch(stderr, /stale comment/);
  assert.match(stderr, /1 offense\(s\) outside the changed lines ignored/);
});

test("scope: files reports every offense, as before", () => {
  const { status, stderr } = run(fixtureRepo("files"));
  assert.equal(status, 2);
  assert.match(stderr, /app\/old\.rb:1: stale comment/);
  assert.match(stderr, /3 offense\(s\)/);
});
