// Working-tree fingerprint behind `run --fast --if-changed`.
//
// Agents in auto mode edit through Bash — sed, heredocs, scripts — so a
// fast hook matched only on the edit tools never fires for them. Matching
// Bash too means firing after every command, and most commands are reads.
// The fingerprint makes those free: HEAD plus every dirty path with its
// size and mtime, hashed. A further edit to an already-dirty file moves
// its mtime, so the stamp tracks edits rather than just the set of dirty
// paths. Stamps live outside the repo, like the journal.
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function stampDir() {
  return join(homedir(), ".highball", "stamps");
}

// One stamp per CHECKOUT, not per project: git worktrees and parallel
// clones share a project name but not a working tree, and a run in one
// must never let the other skip a run it needs.
export function stampPath(project, cwd, dir = stampDir()) {
  const checkout = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(dir, `${project}-${checkout}`);
}

// null outside a git repo: with no way to tell whether anything changed,
// --if-changed must never skip.
export function treeFingerprint(cwd = process.cwd()) {
  const sh = (command) => {
    try {
      return execSync(command, { cwd, encoding: "utf8", stdio: [ "ignore", "pipe", "ignore" ] }).trim();
    } catch {
      return "";
    }
  };
  const head = sh("git rev-parse HEAD");
  if (!head) return null;

  const hash = createHash("sha256").update(head).update("\0");
  const status = sh("git status --porcelain=v1 -z --untracked-files=all");
  for (const entry of status.split("\0").filter(Boolean)) {
    hash.update(entry).update("\0");
    try {
      const stat = statSync(join(cwd, entry.slice(3)));
      hash.update(`${stat.size}:${stat.mtimeMs}`);
    } catch {
      hash.update("gone");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function readStamp(project, cwd, dir = stampDir()) {
  try {
    return readFileSync(stampPath(project, cwd, dir), "utf8").trim();
  } catch {
    return null;
  }
}

// Best-effort, like the journal: a stamp that fails to write costs one
// extra fast run, never a failed one.
export function writeStamp(project, cwd, fingerprint, dir = stampDir()) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(stampPath(project, cwd, dir), `${fingerprint}\n`);
  } catch {
    // ignore
  }
}
