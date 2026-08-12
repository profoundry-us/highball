import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestUserPrompt } from "../lib/transcript.js";

function transcript(lines) {
  const path = join(mkdtempSync(join(tmpdir(), "hb-transcript-")), "session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

test("returns the last real user prompt, skipping tool results", () => {
  const path = transcript([
    { type: "user", message: { role: "user", content: "Fix the login bug" } },
    { type: "assistant", message: { role: "assistant", content: [ { type: "text", text: "On it" } ] } },
    { type: "user", message: { role: "user", content: [ { type: "tool_result", content: "ok" } ] } },
    { type: "user", message: { role: "user", content: [ { type: "text", text: "Now add the  logout\nbutton" } ] } },
    { type: "user", message: { role: "user", content: [ { type: "tool_result", content: "done" } ] } }
  ]);

  assert.equal(latestUserPrompt(path), "Now add the logout button");
});

test("skips meta lines, command wrappers, and interruptions", () => {
  const path = transcript([
    { type: "user", message: { role: "user", content: "Real work description" } },
    { type: "user", isMeta: true, message: { role: "user", content: "Caveat: injected context" } },
    { type: "user", message: { role: "user", content: "<command-name>/status</command-name>" } },
    { type: "user", message: { role: "user", content: "[Request interrupted by user]" } }
  ]);

  assert.equal(latestUserPrompt(path), "Real work description");
});

test("truncates long prompts and collapses whitespace", () => {
  const path = transcript([
    { type: "user", message: { role: "user", content: "x".repeat(300) } }
  ]);

  const prompt = latestUserPrompt(path);
  assert.equal(prompt.length, 120);
  assert.ok(prompt.endsWith("…"));
});

test("degrades to null for missing or unreadable transcripts", () => {
  assert.equal(latestUserPrompt("/nope/missing.jsonl"), null);
  assert.equal(latestUserPrompt(null), null);
});
