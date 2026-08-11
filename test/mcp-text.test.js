import { test } from "node:test";
import assert from "node:assert/strict";
import { detailText, listText } from "../lib/mcp.js";

const run = {
  index: 1, started_at: "2026-08-12T01:00:00Z", duration_ms: 4432,
  trigger: "stop", branch: "main", commit: "abc123456", status: "failed",
  results: [
    { id: "lint", name: "Lint", status: "passed", duration_ms: 2100, output_tail: null },
    { id: "tests", name: "Tests", status: "failed", duration_ms: 900,
      output_tail: "1 example, 1 failure" },
    { id: "later", name: "Later", status: "todo", duration_ms: null, output_tail: null }
  ]
};

test("listText renders an aligned glyph table", () => {
  const text = listText("demo", [ run ]);
  assert.match(text, /Runs for demo/);
  assert.match(text, /#1\s+✗ FAILED\s+full\s+main/);
  assert.match(text, /✓✗•/);
});

test("listText handles an empty history", () => {
  assert.match(listText("demo", []), /No runs recorded/);
});

test("detailText inlines failure output under the failing rule", () => {
  const text = detailText("demo", 1, run);
  assert.match(text, /Run #1 — demo · full suite · main · abc1234 · failed/);
  assert.match(text, /✗ Tests — failed \(0\.9s\)\n\s+1 example, 1 failure/);
  assert.match(text, /• Later — todo/);
  assert.doesNotMatch(text, /Lint — passed[\s\S]*offenses/);
});
