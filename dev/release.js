#!/usr/bin/env node
// `npm run release -- <version>` — the human half of a release.
//
// A release is a bump commit that ships alone in its own PR, and this is
// the script that writes it: it refuses to run anywhere but a clean main
// that matches origin, bumps package.json, moves the changelog's
// Unreleased section under a dated heading, commits on release/<version>,
// pushes, and opens the PR with that section as its body. Then it puts
// you back on main with the local branch gone.
//
// Merging that PR IS the release: tag-release.yml tags the merged commit
// and dispatches publish.yml. Nobody pushes a tag by hand, which is how a
// tag once collided with a branch of the same name and was refused.
//
// `--dry-run` runs every check and prints the plan without writing a byte.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = "profoundry-us/highball";
const CHANGELOG = "CHANGELOG.md";

// --- the pure part: what the changelog looks like after the cut ---

// Moves everything under "## [Unreleased]" beneath a new dated heading for
// `version`, and points the compare links at it. Throws when Unreleased is
// empty: a release with nothing in it is a mistake, not a no-op.
export function cutChangelog(text, version, date) {
  const heading = "## [Unreleased]\n";
  const start = text.indexOf(heading);
  if (start === -1) throw new Error(`${CHANGELOG} has no "## [Unreleased]" section.`);
  const bodyStart = start + heading.length;
  const next = text.indexOf("\n## [", bodyStart);
  const body = text.slice(bodyStart, next === -1 ? undefined : next + 1);
  if (!/^### /m.test(body)) {
    throw new Error(`${CHANGELOG}: the Unreleased section is empty — nothing to release.`);
  }

  const previous = text.match(/^\[Unreleased\]: .*\/compare\/v([^.]+\.[^.]+\.[^.]+)\.\.\.HEAD$/m);
  if (!previous) throw new Error(`${CHANGELOG}: no "[Unreleased]: …/compare/vX.Y.Z...HEAD" link to update.`);
  const previousVersion = previous[1];
  if (previousVersion === version) throw new Error(`${version} is the version already released.`);

  return text
    .replace(heading + body, `${heading}\n## [${version}] - ${date}\n\n${body.replace(/^\n+/, "")}`)
    .replace(previous[0],
      `[Unreleased]: https://github.com/${REPO}/compare/v${version}...HEAD\n` +
      `[${version}]: https://github.com/${REPO}/compare/v${previousVersion}...v${version}`);
}

// The changelog section for `version`, for the PR body.
export function sectionFor(text, version) {
  const heading = `## [${version}] - `;
  const start = text.indexOf(heading);
  if (start === -1) return "";
  const from = text.indexOf("\n", start) + 1;
  // Up to the next version heading or the link block at the bottom.
  const end = text.slice(from).search(/\n(## \[|\[[^\]]+\]: )/);
  return text.slice(from, end === -1 ? undefined : from + end).trim();
}

// --- the shell part ---

const sh = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: [ "ignore", "pipe", "pipe" ], ...options }).trim();

function preflight(version) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`"${version}" is not a plain X.Y.Z version.`);
  const current = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (version === current) problems.push(`package.json is already at ${version}.`);
  if (sh("git", [ "branch", "--show-current" ]) !== "main") problems.push("Not on main.");
  // Untracked files are fine (only named files are committed); tracked
  // changes are not — they would ride along in the release commit.
  const dirty = sh("git", [ "status", "--porcelain" ]).split("\n")
    .map((line) => line.trim()).filter((line) => line && !line.startsWith("??"));
  if (dirty.length) problems.push(`Tracked changes in the working tree:\n${dirty.join("\n")}`);
  sh("git", [ "fetch", "-q", "origin", "main" ]);
  if (sh("git", [ "rev-parse", "HEAD" ]) !== sh("git", [ "rev-parse", "origin/main" ])) {
    problems.push("main is not at origin/main — pull (or push) first.");
  }
  if (sh("git", [ "ls-remote", "--tags", "origin", `v${version}` ])) problems.push(`Tag v${version} already exists on origin.`);
  try {
    sh("gh", [ "auth", "status" ]);
  } catch {
    problems.push("gh is not authenticated.");
  }
  try {
    cutChangelog(readFileSync(CHANGELOG, "utf8"), version, "0000-00-00");
  } catch (error) {
    problems.push(error.message);
  }
  return problems;
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const version = argv.find((arg) => !arg.startsWith("--"));
  if (!version) {
    console.error("usage: npm run release -- <version> [--dry-run]");
    return 1;
  }

  const problems = preflight(version);
  if (problems.length) {
    console.error(`highball release: not cutting ${version}:\n- ${problems.join("\n- ")}`);
    return 1;
  }

  const date = new Date().toISOString().slice(0, 10);
  const branch = `release/${version}`;
  const changelog = cutChangelog(readFileSync(CHANGELOG, "utf8"), version, date);
  const section = sectionFor(changelog, version);
  const body = [
    `The version bump for ${version}. The changelog's Unreleased section moves under the version; nothing else changes.`,
    "",
    `## What ${version} ships`,
    "",
    section,
    "",
    "Merging this PR is the release: CI tags the merged commit `v" + version + "`, publishes to npm, and creates the GitHub release. The site's version link picks it up on its own.",
    ""
  ].join("\n");

  if (dryRun) {
    console.log(`would cut ${version} on ${branch} (dated ${date}):\n`);
    console.log(`--- ${CHANGELOG} section ---\n${section}\n`);
    console.log("--- PR body ---\n" + body);
    console.log("dry run — nothing written.");
    return 0;
  }

  sh("npm", [ "version", version, "--no-git-tag-version" ]);
  writeFileSync(CHANGELOG, changelog);
  sh("git", [ "checkout", "-q", "-b", branch ]);
  sh("git", [ "add", "package.json", "package-lock.json", CHANGELOG ]);
  sh("git", [ "commit", "-q", "-m", `v${version}` ]);
  sh("git", [ "push", "-q", "-u", "origin", branch ]);
  const url = sh("gh", [ "pr", "create", "--repo", REPO, "--title", `v${version}`, "--body", body ]);
  // Back on main, local branch gone: the PR is the only copy that matters,
  // and nothing named like a tag is left behind.
  sh("git", [ "checkout", "-q", "main" ]);
  sh("git", [ "branch", "-D", branch ]);
  console.log(`opened ${url}\nreview, merge, and CI does the rest.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    // A failed step after the checks passed. The tree says where it got to
    // (`git status`, `git branch`); the message says what refused.
    const detail = error.stderr?.toString().trim() || error.message;
    console.error(`highball release: failed — ${detail}`);
    process.exit(1);
  }
}
