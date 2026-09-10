// `highball run [--fast]` — the enforcement half. Runs each rule, prints
// progress, exits 2 with failures on stderr (the Claude Code hook
// contract: a Stop hook reading exit 2 blocks the agent and feeds the
// output back). Reporting is the witness half and is best-effort: an
// unreachable PostHog must never block the agent.
import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CONFIG_PATH, DISABLED_MARKER, disabledByEnv, disabledByMarker,
  loadConfig, resolvePosthog, commandFor, timeoutFor
} from "./config.js";
import { appendRun } from "./journal.js";
import { readStamp, treeFingerprint, writeStamp } from "./stamp.js";
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

  // Off switch #1, deliberately ahead of the config load: HIGHBALL_DISABLED
  // is the one to reach for mid-task, so it has to work even when
  // checks.yml is itself the thing in the way. Per machine, nothing to
  // commit, nothing to accidentally push at a teammate.
  if (disabledByEnv()) {
    console.log("highball: disabled by HIGHBALL_DISABLED — no checks run");
    return 0;
  }

  // Off switch #2, also ahead of the config load and for the same reason:
  // the marker is a bare file next to checks.yml, so it still works when
  // checks.yml is itself what's in the way.
  const marker = disabledByMarker();
  if (marker) {
    const why = marker.reason ? ` (${marker.reason})` : "";
    console.log(`highball: disabled by ${DISABLED_MARKER}${why} — no checks run`);
    return 0;
  }

  const fastOnly = args.includes("--fast");
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`highball: ${error.message}`);
    return 1;
  }

  // Off switch #2, the committed counterpart: this repo isn't using
  // Highball right now, for everyone who clones it. Neither switch is ever
  // silent — a guardrail that has stopped guarding should say so on every
  // single run, or the next person reads green and believes it.
  if (config.enabled === false) {
    console.log(
      `highball: disabled by \`enabled: false\` in ${CONFIG_PATH} — no checks run`
    );
    return 0;
  }

  // --if-changed: a fast hook that also matches Bash fires after every
  // command, and most commands are reads. Skip outright when the working
  // tree is exactly where the last run left it. The fingerprint is taken
  // now and stamped after the checks, so a formatter that rewrites files
  // mid-run makes the next call run again rather than trust a stale pass.
  const fingerprint = treeFingerprint();
  if (args.includes("--if-changed") && fingerprint &&
      fingerprint === readStamp(config.project, process.cwd())) {
    console.log("highball: no changes since the last run — skipped");
    return 0;
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

  // Everything the journal record needs that doesn't change during the
  // run, gathered once: the record is written many times (below), and the
  // transcript read behind `work` is not free.
  const context = {
    id: randomUUID(),
    project: config.project,
    startedAt,
    fastOnly,
    session: hook.session_id || null,
    work: latestUserPrompt(hook.transcript_path),
    branch: git("git branch --show-current"),
    commit: git("git rev-parse HEAD")
  };

  // The journal sees the run from its first moment, not its last. One
  // record per run, written when the run starts and rewritten after every
  // rule (same id, so it replaces itself), so a run that never reaches the
  // end — a hook timeout, a killed terminal, a crash — still leaves behind
  // exactly how far it got and which rule it was in. Before this, a run
  // that died mid-rule was journaled nowhere at all, and "npm test hangs
  // sometimes" had no evidence to point at. Failures to write never fail
  // the checks, same policy as reporting.
  const journal = (status) => {
    try {
      appendRun(config.project, journalRecord(context, status, results));
    } catch (error) {
      console.error(`highball journal skipped: ${error.message}`);
    }
  };
  journal("running");

  // A stopped runner — Claude Code giving up on the hook, a Ctrl-C, a
  // closed terminal — takes the rule it was in down with it and says so in
  // the journal, instead of leaving a hung suite running on unowned and a
  // run that looks like it never happened. `current` is the child of the
  // rule executing right now; `stopped` remembers the signal so the loop
  // can wind down rather than start the next rule.
  let current = null;
  let stopped = null;
  const onSignal = (signal) => {
    if (stopped) return;
    stopped = signal;
    if (current) killTree(current);
  };
  const SIGNALS = [ "SIGTERM", "SIGINT", "SIGHUP" ];
  for (const signal of SIGNALS) process.on(signal, onSignal);

  try {
    for (const rule of rules) {
      process.stdout.write(`→ ${rule.name} ... `);

      // Placeholder rules are tracked, not run: they report as "todo" so
      // the widget and PostHog show the full intended ruleset, and they can never
      // fail a run — an aspiration shouldn't block anyone.
      if (rule.todo) {
        console.log("todo (not implemented yet)");
        results.push({ rule, passed: true, todo: true, durationMs: null, output: "" });
        journal("running");
        continue;
      }

      const timeoutMs = timeoutFor(rule, config);
      const t0 = process.hrtime.bigint();
      let outcome;

      // Rubric rules run in-process instead of shelling out: the judge needs
      // the `claude` CLI, which lives on the host, so it bypasses `exec.via`
      // by construction rather than by annotation.
      if (rule.rubric) {
        outcome = judge({ rubricPath: rule.rubric, changed, timeoutMs });
      } else {
        // The runner owns git (ADR 202608): check scripts get the changed
        // list handed to them and stay pure analyzers — no git, no network
        // required in their execution context (which may be a container).
        const child = await runCommand(commandFor(rule, config), {
          env: { ...process.env, HIGHBALL_CHANGED_FILES: changed },
          timeoutMs,
          onSpawn: (spawned) => { current = spawned; }
        });
        current = null;
        outcome = { passed: child.status === 0, output: child.output, timedOut: child.timedOut };
      }

      const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      const result = { rule, passed: outcome.passed, todo: false, durationMs, output: outcome.output };

      if (stopped) {
        // Whatever the child reported, it reported because we killed it.
        result.passed = false;
        result.killed = true;
        result.output = `${outcome.output}\n\nhighball was stopped (${stopped}) while this rule was running.`;
        console.log(`KILLED (${(durationMs / 1000).toFixed(1)}s)`);
        results.push(result);
        break;
      }

      if (outcome.timedOut) {
        result.passed = false;
        result.timedOut = true;
        result.output = `${outcome.output}\n\n${timeoutAdvice(rule, config, timeoutMs)}`;
        console.log(`TIMED OUT (${(durationMs / 1000).toFixed(1)}s)`);
      } else {
        console.log(`${result.passed ? "passed" : "FAILED"} (${(durationMs / 1000).toFixed(1)}s)`);
      }
      results.push(result);
      journal("running");
    }
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }

  if (stopped) {
    journal("killed");
    console.error(`\nhighball: stopped by ${stopped} — run journaled as killed`);
    return 1;
  }

  // Stamped pass or fail: after a failure the agent's next reads must not
  // re-run and re-block; its next edit moves the tree and runs again.
  if (fingerprint) writeStamp(config.project, process.cwd(), fingerprint);

  const failures = results.filter((result) => !result.passed);
  const durationMs = Date.now() - startedAt.getTime();

  const { host, key } = resolvePosthog(config);
  if (host && key) {
    await reportPosthog({
      host, key, project: config.project, results, hook, fastOnly, startedAt,
      durationMs, branch: context.branch, commitSha: context.commit, version: VERSION
    });
  }

  // The local journal is unconditional — `highball runs` works with no
  // reporting configured at all.
  journal(failures.length === 0 ? "passed" : "failed");

  if (failures.length === 0) return 0;

  for (const failure of failures) {
    console.error(
      `\n### ${failure.rule.name} (${failure.rule.id}) failed. ` +
        `Fix before finishing:\n${failure.output}`
    );
  }
  return 2;
}

// The journal's view of a run at some moment: the same shape whether the
// run is still going, finished, or was stopped, so every reader handles
// one record type and `status` alone says which.
function journalRecord(context, status, results) {
  return {
    id: context.id,
    started_at: context.startedAt.toISOString(),
    // The repo this run happened in — how the MCP server later resolves
    // "the current project" and grounds the widget's re-run buttons.
    dir: process.cwd(),
    // Which agent session, and what it was working on — the grouping
    // key and label for run history views. The hook payload points at
    // the session transcript; its last real user prompt is the work.
    session: context.session,
    work: context.work,
    duration_ms: Date.now() - context.startedAt.getTime(),
    trigger: context.fastOnly ? "edit" : "stop",
    branch: context.branch,
    commit: context.commit,
    status,
    results: results.map((result) => ({
      id: result.rule.id,
      name: result.rule.name,
      status: result.todo ? "todo" : result.passed ? "passed" : "failed",
      duration_ms: result.durationMs,
      // Why a failed rule failed, when the reason was the runner's and not
      // the rule's. Absent otherwise, so ordinary records stay as they were.
      ...(result.timedOut ? { timed_out: true } : {}),
      ...(result.killed ? { killed: true } : {}),
      // The command that produced this result. Quiet rules journal no
      // output at all (the AI judges print nothing when they pass), which
      // left viewers with an expandable row wrapping an empty panel; the
      // command is the one detail every real rule can always show. todo
      // rules have no command — nothing ran — which is exactly what makes
      // them inert rather than falsely clickable.
      command:
        result.rule.run ??
        (result.rule.rubric ? `judge ${result.rule.rubric}` : null),
      // Unlike PostHog (one-line summaries only), the journal keeps
      // every rule's output GitHub-Actions-style — it's the user's own
      // disk, and `highball runs <n> --logs` is the payoff.
      output_tail: result.output ? result.output.slice(-10_000) : null
    }))
  };
}

// What the agent reads after a rule ran out of time. It names the knob,
// because the right fix is sometimes a slower rule's honest budget and
// sometimes a hang — and either way the number should be a decision
// someone made in checks.yml, not a mystery.
function timeoutAdvice(rule, config, timeoutMs) {
  const seconds = timeoutMs / 1000;
  const knob = rule.timeout != null
    ? `\`timeout: ${seconds}\` on this rule`
    : `\`timeouts.${rule.rubric ? "judge" : rule.fast ? "fast" : "full"}: ${seconds}\``;
  return `highball: timed out after ${seconds}s and was killed. Its budget is ${knob} ` +
    `in ${CONFIG_PATH} — raise it there if this rule legitimately needs longer, ` +
    "or find what hung.";
}

// Output kept per rule. Past this the rest is dropped rather than buffered:
// a runaway logger must not turn into a runaway runner.
const MAX_OUTPUT = 32 * 1024 * 1024;

// Runs one rule's command with a wall-clock budget. Resolves rather than
// rejects in every case — a rule that can't even start is a failed rule
// with the error as its output, not a crashed runner.
function runCommand(command, { env, timeoutMs, onSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(`${command} 2>&1`, {
      shell: true,
      // Its own process group (POSIX), so a timeout can kill the rule's
      // whole tree — the shell, the npm it started, the test runner npm
      // started — and not just the shell, which would leave a hung suite
      // running on after the run had already given up on it.
      detached: process.platform !== "win32",
      env,
      stdio: [ "ignore", "pipe", "pipe" ]
    });
    onSpawn?.(child);

    let output = "";
    const collect = (chunk) => {
      if (output.length < MAX_OUTPUT) output += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", collect);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, output: `${output}${error.message}\n`, timedOut });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output, timedOut });
    });
  });
}

// Stops a rule's whole process tree: SIGTERM to the group first so
// anything listening can clean up, SIGKILL a moment later for whatever
// didn't. Exported for tests.
export function killTree(child) {
  const signal = (name) => {
    try {
      if (process.platform === "win32" || !child.pid) child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const escalate = setTimeout(() => signal("SIGKILL"), 1000);
  escalate.unref();
  child.once("close", () => clearTimeout(escalate));
}

// Claude Code hooks pass a JSON payload on stdin (session_id and
// friends); that id groups this run with the rest of the agent's session
// in the journal and in PostHog. A TTY means a human at a terminal — don't block on
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
