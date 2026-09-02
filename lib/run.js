// `highball run [--fast]` — the enforcement half. Runs each rule, prints
// progress, exits 2 with failures on stderr (the Claude Code hook
// contract: a Stop hook reading exit 2 blocks the agent and feeds the
// output back). Reporting is the witness half and is best-effort: a dead
// dashboard must never block the agent.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadConfig, resolvePosthog, commandFor } from "./config.js";
import { appendRun } from "./journal.js";
import { git } from "./git.js";
import { reportPosthog } from "./posthog.js";
import { judge } from "./judge.js";
import { latestUserPrompt } from "./transcript.js";

// Stamped onto reported events so a query can tell which runner
// produced them — rule semantics change between releases.
const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

export async function run(args) {
  // When an AI-judged rule spawns a judge session inside this repo, the
  // judge inherits the repo's hooks — and its Stop hook would re-enter
  // this runner and spawn another judge, forever. The env var breaks the
  // loop.
  if (process.env.HIGHBALL_JUDGE) return 0;

  const fastOnly = args.includes("--fast");
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`highball: ${error.message}`);
    return 1;
  }

  // Rubric rules never join a fast run, even if a config marks one `fast`:
  // LLM latency and cost would be paid on every edit. That belongs at turn
  // end, and the invariant is enforced here rather than left to each repo.
  const rules = fastOnly
    ? config.checks.filter((rule) => rule.fast && !rule.rubric)
    : config.checks;
  const hook = await readHookPayload();
  const changed = changedFiles();

  // Captured before the loop and reported as the run's started_at: the
  // run is opened AFTER checks finish (one reporting burst, no mid-run
  // network stalls), so without this the server would clock the run at
  // the length of the reporting window instead of the checks themselves.
  const startedAt = new Date();
  const results = [];

  for (const rule of rules) {
    process.stdout.write(`→ ${rule.name} ... `);

    // Placeholder rules are tracked, not run: they report as "todo" so
    // the dashboard shows the full intended ruleset, and they can never
    // fail a run — an aspiration shouldn't block anyone.
    if (rule.todo) {
      console.log("todo (not implemented yet)");
      results.push({ rule, passed: true, todo: true, durationMs: null, output: "" });
      continue;
    }

    // Rubric rules run in-process instead of shelling out: the judge needs
    // the `claude` CLI, which lives on the host, so it bypasses `exec.via`
    // by construction rather than by annotation.
    if (rule.rubric) {
      const t0 = process.hrtime.bigint();
      const { passed, output } = judge({ rubricPath: rule.rubric, changed });
      const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

      console.log(`${passed ? "passed" : "FAILED"} (${(durationMs / 1000).toFixed(1)}s)`);
      results.push({ rule, passed, todo: false, durationMs, output });
      continue;
    }

    const command = commandFor(rule, config);
    const t0 = process.hrtime.bigint();
    // The runner owns git (ADR 202608): check scripts get the changed
    // list handed to them and stay pure analyzers — no git, no network
    // required in their execution context (which may be a container).
    const child = spawnSync(`${command} 2>&1`, {
      shell: true,
      encoding: "utf8",
      env: { ...process.env, HIGHBALL_CHANGED_FILES: changed },
      maxBuffer: 32 * 1024 * 1024
    });
    const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const output = child.stdout ?? "";
    const passed = child.status === 0;

    console.log(`${passed ? "passed" : "FAILED"} (${(durationMs / 1000).toFixed(1)}s)`);
    results.push({ rule, passed, todo: false, durationMs, output });
  }

  const failures = results.filter((result) => !result.passed);
  const durationMs = Date.now() - startedAt.getTime();
  const branch = git("git branch --show-current");
  const commitSha = git("git rev-parse HEAD");

  const { host, key } = resolvePosthog(config);
  if (host && key) {
    await reportPosthog({
      host, key, project: config.project, results, hook, fastOnly, startedAt,
      durationMs, branch, commitSha, version: VERSION
    });
  }

  // The local journal is unconditional — `highball runs` works with no
  // dashboard configured at all. Journal failures never fail the checks,
  // same policy as reporting.
  try {
    appendRun(config.project, {
      started_at: startedAt.toISOString(),
      // The repo this run happened in — how the MCP server later resolves
      // "the current project" and grounds the widget's re-run buttons.
      dir: process.cwd(),
      // Which agent session, and what it was working on — the grouping
      // key and label for run history views. The hook payload points at
      // the session transcript; its last real user prompt is the work.
      session: hook.session_id || null,
      work: latestUserPrompt(hook.transcript_path),
      duration_ms: durationMs,
      trigger: fastOnly ? "edit" : "stop",
      branch,
      commit: commitSha,
      status: failures.length === 0 ? "passed" : "failed",
      results: results.map((result) => ({
        id: result.rule.id,
        name: result.rule.name,
        status: result.todo ? "todo" : result.passed ? "passed" : "failed",
        duration_ms: result.durationMs,
        // The command that produced this result. Quiet rules journal no
        // output at all (the AI judges print nothing when they pass), which
        // left viewers with an expandable row wrapping an empty panel; the
        // command is the one detail every real rule can always show. todo
        // rules have no command — nothing ran — which is exactly what makes
        // them inert rather than falsely clickable.
        command:
          result.rule.run ??
          (result.rule.rubric ? `judge ${result.rule.rubric}` : null),
        // Unlike the dashboard (failure tails only), the journal keeps
        // every rule's output GitHub-Actions-style — it's the user's own
        // disk, and `highball runs <n> --logs` is the payoff.
        output_tail: result.output ? result.output.slice(-10_000) : null
      }))
    });
  } catch (error) {
    console.error(`highball journal skipped: ${error.message}`);
  }

  if (failures.length === 0) return 0;

  for (const failure of failures) {
    console.error(
      `\n### ${failure.rule.name} (${failure.rule.id}) failed. ` +
        `Fix before finishing:\n${failure.output}`
    );
  }
  return 2;
}

// Claude Code hooks pass a JSON payload on stdin (session_id and
// friends); that id groups this run with the rest of the agent's session
// on the dashboard. A TTY means a human at a terminal — don't block on
// read.
//
// The deadline matters: a non-TTY stdin that nobody writes to and nobody
// closes (a pipeline, a task runner, a CI step) would otherwise hang the
// runner forever waiting for EOF. Hooks write their payload immediately,
// so a short wait costs nothing and turns an indefinite hang into a run
// with no session context.
const HOOK_STDIN_DEADLINE_MS = 400;

async function readHookPayload() {
  if (process.stdin.isTTY) return {};
  try {
    const text = await Promise.race([
      (async () => {
        let buffered = "";
        for await (const chunk of process.stdin) buffered += chunk;
        return buffered;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(""), HOOK_STDIN_DEADLINE_MS))
    ]);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Changed = branch work in progress: tracked edits vs HEAD plus
// untracked files. Handed to check scripts via HIGHBALL_CHANGED_FILES
// (newline-separated, repo-relative). Skipped past 100KB — env vars
// share the OS arg-space budget, and a monster refactor shouldn't make
// every rule invocation fail; scripts fall back to their own git.
function changedFiles() {
  try {
    const tracked = execSync("git diff --name-only HEAD 2>/dev/null", {
      encoding: "utf8"
    });
    const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
      encoding: "utf8"
    });
    const list = `${tracked}\n${untracked}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
    return list.length > 100_000 ? "" : list;
  } catch {
    return "";
  }
}
