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
  DEFAULT_CONCURRENCY, loadConfig, resolvePosthog, commandFor, execContext, timeoutFor
} from "./config.js";
import { createPool } from "./pool.js";
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

  // --if-changed: a fast hook that also matches Bash fires after every
  // command, and most commands are reads; a Stop hook fires at every turn
  // end, edits or not. Skip outright when the working tree is exactly
  // where the last run OF THIS MODE left it — a fast run's stamp says
  // nothing about the full-only rules, so it must never satisfy a full
  // run. The fingerprint is taken now and stamped after the checks, so a
  // formatter that rewrites files mid-run makes the next call run again
  // rather than trust a stale pass.
  //
  // This sits ahead of the config load on purpose: a skip is the common
  // case for a hooked repo, and parsing and validating checks.yml is a
  // third of what a skip would otherwise cost. Nothing is lost by the
  // order — a stamp only ever matches a tree state that a run already
  // checked with the checks.yml it contained.
  const mode = fastOnly ? "fast" : "full";
  const fingerprint = treeFingerprint();
  if (args.includes("--if-changed") && fingerprint &&
      fingerprint === readStamp(process.cwd(), mode)) {
    console.log(`highball: no changes since the last ${mode} run — skipped`);
    return 0;
  }

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

  // Echoed like the disabled reason is: a checkout can declare its wrapper
  // in three places, and "why is this running in Docker?" should have an
  // answer on the run itself.
  const exec = execContext(config);
  if (exec.via) console.log(`highball: rules run via \`${exec.via}\` (${exec.source})`);

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
  // One slot per rule, in config order, filled as rules finish — in
  // whatever order that is once some run alongside others. The journal,
  // the failure report and PostHog all read them back in config order.
  const slots = new Array(rules.length);
  const settled = () => slots.filter(Boolean);

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
      appendRun(config.project, journalRecord(context, status, settled()));
    } catch (error) {
      console.error(`highball journal skipped: ${error.message}`);
    }
  };
  journal("running");

  // A stopped runner — Claude Code giving up on the hook, a Ctrl-C, a
  // closed terminal — takes everything it started down with it and says so
  // in the journal, instead of leaving a hung suite running on unowned and a
  // run that looks like it never happened. `running` is every child not yet
  // reaped: the sequential rule, rules running alongside it, every judge
  // call, a wrapper probe. `stopped` remembers the signal so the run winds
  // down rather than start anything new.
  const running = new Set();
  const track = (child) => {
    running.add(child);
    child.once("close", () => running.delete(child));
  };
  let stopped = null;
  const onSignal = (signal) => {
    if (stopped) return;
    stopped = signal;
    for (const child of running) killTree(child);
  };
  const SIGNALS = [ "SIGTERM", "SIGINT", "SIGHUP" ];
  for (const signal of SIGNALS) process.on(signal, onSignal);

  // Once one wrapped rule has hung, the rest will too: a daemon that
  // accepts connections and never answers hangs every `docker compose
  // exec` alike, and each rule would pay its full budget for the same
  // fact. On the first wrapped timeout the wrapper itself is probed once
  // (`<via> true`, under the fast budget). If the probe also fails, the
  // remaining wrapped rules fail at once with the probe's diagnosis and
  // host rules carry on; if it passes, the rule really hung and nothing
  // changes. null = not yet asked, false = answered, an object = down.
  // The probe is shared, so rules timing out side by side ask only once.
  let viaDown = null;
  let viaProbe = null;
  const probeVia = () =>
    (viaProbe ??= probeWrapper(exec, config, changed, track).then((down) => { viaDown = down; }));

  // One limit for everything that runs alongside the sequential lane:
  // every judge call and every `parallel: true` rule holds a slot while it
  // runs. Model calls don't contend with the repo's toolchain, but a dozen
  // headless Claude processes at once contend with everything else.
  const pool = createPool(config.concurrency ?? DEFAULT_CONCURRENCY);
  let lineRanges = null;
  const changedLineRanges = () => (lineRanges ??= changedLines());

  // Runs one rule to a result, without printing. null when the runner was
  // stopped before the rule could start.
  const execute = async (rule) => {
    if (stopped) return null;
    const wrapped = Boolean(exec.via) && !rule.rubric && rule.exec !== "host";
    const command = commandFor(rule, config);

    if (wrapped && viaDown) {
      return {
        rule, command, passed: false, todo: false, durationMs: 0, viaDown: true,
        output: wrapperDownAdvice(exec, viaDown, rule)
      };
    }

    const timeoutMs = timeoutFor(rule, config);
    const t0 = process.hrtime.bigint();
    let outcome;

    // Rubric rules run in-process instead of shelling out: the judge needs
    // the `claude` CLI, which lives on the host, so it bypasses `exec.via`
    // by construction rather than by annotation.
    if (rule.rubric) {
      outcome = await judge({
        rubricPath: rule.rubric, changed, changedLines: changedLineRanges, timeoutMs,
        pool, onSpawn: track, aborted: () => Boolean(stopped)
      });
    } else {
      // The runner owns git (ADR 202608): check scripts get the changed
      // list handed to them and stay pure analyzers — no git, no network
      // required in their execution context (which may be a container).
      const child = await runCommand(command, {
        env: { ...process.env, HIGHBALL_CHANGED_FILES: changed },
        timeoutMs,
        onSpawn: track
      });
      outcome = { passed: child.status === 0, output: child.output, timedOut: child.timedOut };
    }

    const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const result = { rule, command, passed: outcome.passed, todo: false, durationMs, output: outcome.output };

    if (stopped) {
      // Whatever the child reported, it reported because we killed it.
      result.passed = false;
      result.killed = true;
      result.output = `${outcome.output}\n\nhighball was stopped (${stopped}) while this rule was running.`;
      return result;
    }

    if (outcome.timedOut) {
      result.passed = false;
      result.timedOut = true;
      if (wrapped) await probeVia();
      result.viaDown = wrapped && Boolean(viaDown);
      result.output = result.viaDown
        ? `${outcome.output}\n\n${wrapperDownAdvice(exec, viaDown, rule)}`
        : `${outcome.output}\n\n${timeoutAdvice(rule, config, timeoutMs, wrapped ? exec : null)}`;
    }
    return result;
  };

  // What gets printed after "→ name ... ".
  const label = (result) => {
    if (result.todo) return "todo (not implemented yet)";
    const seconds = `${(result.durationMs / 1000).toFixed(1)}s`;
    if (result.killed) return `KILLED (${seconds})`;
    if (result.timedOut) return `TIMED OUT (${seconds})${result.viaDown ? " — exec.via isn't answering" : ""}`;
    if (result.viaDown) return "FAILED (exec.via isn't answering)";
    return `${result.passed ? "passed" : "FAILED"} (${seconds})`;
  };

  // A rule a crash inside the runner took down is a failed rule with the
  // error as its output, never an unhandled rejection that loses the run.
  const crashed = (rule, error) => ({
    rule, passed: false, todo: false, durationMs: 0, output: `highball: ${error.stack ?? error.message}`
  });

  // Two lanes. Rubric rules, and any rule marked `parallel: true`, run
  // alongside everything else from the start — a judge waiting on a model
  // and a suite running in a container don't contend, and the run should
  // take as long as its slowest rule rather than the sum of them. The rest
  // run one at a time in config order, as they always have; `parallel:
  // false` keeps a rubric rule in that lane.
  //
  // Printing follows: the sequential lane writes "→ name ... " and finishes
  // the line when its rule does. Rules running alongside finish whenever
  // they finish, so their lines wait until the sequential lane is between
  // rules rather than landing in the middle of one.
  const alongside = (rule) => !rule.todo && (rule.parallel ?? Boolean(rule.rubric));
  let midLine = false;
  const held = [];
  const say = (line) => (midLine ? held.push(line) : console.log(line));
  const flush = () => { while (held.length) console.log(held.shift()); };

  const background = rules.flatMap((rule, index) => {
    if (!alongside(rule)) return [];
    // A judge's calls each take a pool slot; a script takes one itself.
    const task = rule.rubric ? execute(rule) : pool.run(() => execute(rule));
    return [ task.catch((error) => crashed(rule, error)).then((result) => {
      if (!result) return;
      slots[index] = result;
      say(`→ ${rule.name} ... ${label(result)}`);
      journal("running");
    }) ];
  });
  if (background.length) {
    const names = rules.filter(alongside).map((rule) => rule.name).join(", ");
    say(`highball: running alongside the rest: ${names}`);
  }

  try {
    for (const [ index, rule ] of rules.entries()) {
      if (alongside(rule)) continue;
      if (stopped) break;
      midLine = true;
      process.stdout.write(`→ ${rule.name} ... `);

      // Placeholder rules are tracked, not run: they report as "todo" so
      // the widget and PostHog show the full intended ruleset, and they can never
      // fail a run — an aspiration shouldn't block anyone.
      const result = rule.todo
        ? { rule, passed: true, todo: true, durationMs: null, output: "" }
        : await execute(rule).catch((error) => crashed(rule, error));

      if (!result) {
        console.log("not started (stopped)");
        midLine = false;
        break;
      }
      slots[index] = result;
      console.log(label(result));
      midLine = false;
      flush();
      journal("running");
      if (result.killed) break;
    }
    midLine = false;
    flush();
    await Promise.all(background);
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }

  if (stopped) {
    journal("killed");
    console.error(`\nhighball: stopped by ${stopped} — run journaled as killed`);
    return 1;
  }

  const results = settled();
  const failures = results.filter((result) => !result.passed);

  // The fast stamp is written pass or fail: after a failure the agent's
  // next reads must not re-run and re-block; its next edit moves the tree
  // and runs again. A full run writes it too — it ran every fast rule, so
  // the next fast call on this tree has nothing to add.
  //
  // The full stamp is written only on a pass, and only by a full run. A
  // fast run never writes it: the full-only rules haven't run. A failed
  // full run doesn't either: the Stop hook's whole job is to block the
  // agent on a red tree, and an agent that ends its turn again without
  // editing must meet the same block, not a skip.
  if (fingerprint) {
    writeStamp(process.cwd(), "fast", fingerprint);
    if (!fastOnly && failures.length === 0) {
      writeStamp(process.cwd(), "full", fingerprint);
    }
  }
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
      // The command that actually ran — through `exec.via` when the rule
      // was wrapped, so a Docker hang reads as a Docker hang in the history
      // rather than as a Python command that mysteriously stalled. Quiet
      // rules journal no output at all (the AI judges print nothing when
      // they pass), which left viewers with an expandable row wrapping an
      // empty panel; the command is the one detail every real rule can
      // always show. todo rules have no command — nothing ran — which is
      // exactly what makes them inert rather than falsely clickable.
      command:
        result.command ??
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
//
// A rule that ran through `exec.via` gets the wrapper named first: a
// wrapper that isn't answering looks exactly like a hung rule from the
// outside, and "raise the budget" is the wrong advice for a 0.2s check.
function timeoutAdvice(rule, config, timeoutMs, exec = null) {
  const seconds = timeoutMs / 1000;
  const knob = rule.timeout != null
    ? `\`timeout: ${seconds}\` on this rule`
    : `\`timeouts.${rule.rubric ? "judge" : rule.fast ? "fast" : "full"}: ${seconds}\``;
  const wrapper = exec
    ? `This rule ran through \`exec.via\` (\`${exec.via}\`, from ${exec.source}); the wrapper ` +
      "answered a probe, so the rule itself is what hung. "
    : "";
  return `highball: timed out after ${seconds}s and was killed. ${wrapper}Its budget is ${knob} ` +
    `in ${CONFIG_PATH} — raise it there if this rule legitimately needs longer, ` +
    "or find what hung.";
}

// `<via> true` under the fast budget: a wrapper that can't run `true` in
// the time a fast rule gets is not going to run anything else either.
// Returns false when it answers, else what it did instead.
async function probeWrapper(exec, config, changed, onSpawn) {
  const timeoutMs = timeoutFor({ fast: true }, config);
  const probe = await runCommand(`${exec.via} true`, {
    env: { ...process.env, HIGHBALL_CHANGED_FILES: changed }, timeoutMs, onSpawn
  });
  if (probe.status === 0 && !probe.timedOut) return false;
  return { timedOut: probe.timedOut, status: probe.status, output: probe.output.trim(), timeoutMs };
}

function wrapperDownAdvice(exec, down, rule) {
  const what = down.timedOut
    ? `hung for ${down.timeoutMs / 1000}s and was killed`
    : `exited ${down.status}${down.output ? `: ${down.output.split("\n").at(-1)}` : ""}`;
  return `highball: \`exec.via\` isn't answering — the probe \`${exec.via} true\` ${what}. ` +
    `Every rule that runs through the wrapper fails until it does (this one: \`${rule.run}\`); ` +
    `rules marked \`exec: host\` are unaffected. The wrapper is declared in ${exec.source} — ` +
    "check the daemon and the container it names.";
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

// Which lines of each changed file this branch touched, for rubrics scoped
// to `changed`: the new-side ranges of `git diff -U0 HEAD`, and every line
// of an untracked file. Computed only when such a rubric asks for it, and
// from the same definition of "changed" as changedFiles below.
export function parseHunks(diff) {
  const ranges = new Map();
  let file = null;
  let inHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      continue;
    }
    // Only in a file header: an added line whose content starts with "++ "
    // also reads "+++ " in the diff body.
    if (inHeader && line.startsWith("+++ ")) {
      const path = line.slice(4);
      file = path === "/dev/null" ? null : path.replace(/^"/, "").replace(/"$/, "").replace(/^b\//, "");
      if (file && !ranges.has(file)) ranges.set(file, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      inHeader = false;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // A pure deletion adds no lines, so there is nothing new to blame.
      if (file && count > 0) ranges.get(file).push([ start, start + count - 1 ]);
    }
  }
  return ranges;
}

function changedLines() {
  let ranges = new Map();
  try {
    ranges = parseHunks(execSync("git -c core.quotePath=false diff -U0 --no-color --no-ext-diff HEAD 2>/dev/null", {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024
    }));
  } catch {
    // No diff to read (no HEAD yet, not a repo): every file counts as new below
    // or has no changed lines, and the judge's filter keeps what it can't place.
  }
  try {
    const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", { encoding: "utf8" });
    for (const path of untracked.split("\n").map((line) => line.trim()).filter(Boolean)) ranges.set(path, "all");
  } catch {
    // ignore
  }
  return ranges;
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
