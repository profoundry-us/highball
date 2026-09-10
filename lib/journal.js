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

// A record carrying an `id` replaces its earlier self rather than adding a
// line: the runner writes a run when it starts and again after every rule,
// so a run cut off mid-way still shows how far it got — one record per run
// either way. Records without an id (older runners, tests) simply append.
export function appendRun(project, record, dir = journalDir()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = journalPath(project, dir);
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean)
    : [];
  const line = JSON.stringify(record);
  const at = record.id === undefined ? -1 : lines.findIndex((existing) => {
    // The substring test keeps this cheap; the parse keeps it honest.
    if (!existing.includes(record.id)) return false;
    try {
      return JSON.parse(existing).id === record.id;
    } catch {
      return false;
    }
  });
  if (at === -1) lines.push(line);
  else lines[at] = line;
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
