// The local run journal: every run appends one JSONL line to
// ~/.highball/runs/<project>.jsonl, whether or not remote reporting is
// configured. This is what makes the runner useful with no telemetry at
// all — `highball runs` and the MCP widget read it — and it lives outside
// the repo tree so there's no gitignore to manage and no state to leak
// into commits.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Per-project cap. At ~1-2KB a line this bounds each file around a
// couple hundred KB — enough history to be useful, never enough to care
// about.
const MAX_RUNS = 200;

export function journalDir() {
  return join(homedir(), ".highball", "runs");
}

export function journalPath(project, dir = journalDir()) {
  return join(dir, `${project}.jsonl`);
}

export function appendRun(project, record, dir = journalDir()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = journalPath(project, dir);
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean)
    : [];
  lines.push(JSON.stringify(record));
  writeFileSync(path, lines.slice(-MAX_RUNS).join("\n") + "\n");
}

// Newest first — the order every "recent runs" view wants.
export function readRuns(project, dir = journalDir()) {
  const path = journalPath(project, dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

export function journaledProjects(dir = journalDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .sort();
}
