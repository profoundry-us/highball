import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeClaude } from "../lib/judge.js";

// A stand-in `claude` on PATH that records its argv, its prompt and the
// recursion guard, then answers like the real CLI's --output-format json.
function fakeClaude(body) {
  const dir = mkdtempSync(join(tmpdir(), "hb-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

async function withPath(dir, fn) {
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
}

test("invokeClaude pipes the prompt, passes the model, and sets the recursion guard", async () => {
  const dir = fakeClaude([
    `echo "$@" > "${"$"}(dirname "$0")/argv"`,
    `cat > "${"$"}(dirname "$0")/prompt"`,
    `echo "$HIGHBALL_JUDGE" > "${"$"}(dirname "$0")/guard"`,
    `printf '%s' '{"result":"{\\"status\\":\\"passed\\",\\"offenses\\":[]}"}'`
  ].join("\n"));
  const call = await withPath(dir, () => invokeClaude({ prompt: "judge this", model: "claude-test", timeoutMs: 5000 }));

  assert.equal(call.status, 0);
  assert.equal(call.timedOut, false);
  assert.match(call.stdout, /"status\\":\\"passed/);
  assert.equal(readFileSync(join(dir, "argv"), "utf8").trim(), "-p --model claude-test --output-format json");
  assert.equal(readFileSync(join(dir, "prompt"), "utf8"), "judge this");
  assert.equal(readFileSync(join(dir, "guard"), "utf8").trim(), "1");
});

test("invokeClaude kills a call past its budget and says so", async () => {
  const dir = fakeClaude("sleep 30");
  const t0 = Date.now();
  const call = await withPath(dir, () => invokeClaude({ prompt: "", model: "m", timeoutMs: 300 }));
  assert.equal(call.timedOut, true);
  assert.ok(Date.now() - t0 < 3000, "killed, not waited out");
});

test("invokeClaude reports a missing CLI as ENOENT rather than throwing", async () => {
  const before = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "hb-empty-"));
  try {
    const call = await invokeClaude({ prompt: "", model: "m", timeoutMs: 1000 });
    assert.equal(call.error?.code, "ENOENT");
  } finally {
    process.env.PATH = before;
  }
});
