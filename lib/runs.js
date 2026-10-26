// `highball runs [n | id] [--logs] [--limit=N] [--slowest[=N] [--fast]]` —
// the terminal view of run history, read from the local journal. Bare: a
// table of recent runs, newest first. With a run number or id: that run's
// detail — failure output by default, every rule's captured output with
// --logs. With --slowest: which rules a run's time goes to.
//
// Every option that takes a value is written `--name=value`. Runners before
// 0.10 read any bare number as "show run N", so `--limit 25` would have
// shown run #25 there; the `=` form is ignored by them instead.
import { findConfigRoot, loadConfig } from "./config.js";
import { readRuns, journaledProjects, resolveRunsLimit, workLabel } from "./journal.js";

// TTY-gated ANSI (NO_COLOR respected, FORCE_COLOR overrides) — hook
// shells and pipes get plain text.
const COLORS_ON = process.env.FORCE_COLOR
  ? true
  : Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const paint = (code, text) => (COLORS_ON ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (text) => paint("32", text);
const red = (text) => paint("31;1", text);
const dim = (text) => paint("2", text);

// A run's status, as a label. "running" is a run the journal has seen
// start and not finish — live, or one that died without saying so.
const runLabel = (status) =>
  status === "passed" ? green("✓ passed")
    : status === "running" ? dim("… running")
      : status === "killed" ? red("✗ KILLED")
        : red("✗ FAILED");

// A rule's status, as a label: a failure the runner caused says why.
const ruleLabel = (result) =>
  result.status === "passed" ? green(result.status)
    : result.status === "todo" ? dim(result.status)
      : red(result.timed_out ? "TIMED OUT" : result.killed ? "KILLED" : result.status.toUpperCase());

// Column math must use what the eye sees, not what the terminal parses.
const visible = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const padEnd = (text, width) => text + " ".repeat(Math.max(0, width - visible(text).length));
const padStart = (text, width) => " ".repeat(Math.max(0, width - visible(text).length)) + text;
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

// How many full runs --slowest looks back over when not told: enough to
// see a typical run past one slow outlier, few enough to be this week's.
export const DEFAULT_SLOWEST_RUNS = 20;

// A run id as the list prints it: six hex characters of the record's UUID,
// which `highball runs <id>` takes back. Records from runners before ids
// existed have none.
export const shortId = (run) => (typeof run.id === "string" ? run.id.slice(0, 6) : "-");

export async function runs(args) {
  const options = parseRunsArgs(args);
  if (options.error) {
    console.error(`highball: ${options.error}`);
    return 1;
  }

  const root = findConfigRoot();
  if (!root) {
    const known = journaledProjects();
    console.error(
      "highball: not inside a configured repo (no .highball/checks.yml here or above)."
    );
    if (known.length > 0) {
      console.error(`Projects with local history: ${known.join(", ")}`);
    }
    return 1;
  }
  let config;
  try {
    config = loadConfig(root);
  } catch (error) {
    console.error(`highball: ${error.message}`);
    return 1;
  }
  const { project } = config;

  const history = readRuns(project);
  if (history.length === 0) {
    console.log(`No local runs recorded for ${project} yet — run \`highball run\`.`);
    return 0;
  }

  if (options.slowest) return slowest(project, history, options);
  if (options.target) {
    const found = findRun(history, options.target);
    if (found.error) {
      console.error(`highball: ${found.error}`);
      return 1;
    }
    return detail(project, found.run, found.index, options.logs);
  }
  const limit = resolveRunsLimit({ limit: options.limit, config, fallback: history.length });
  return list(project, history, limit);
}

// Exported for tests. A value that isn't a positive whole number is an
// error rather than a quiet default: a typo'd limit that silently showed
// everything would look like a working one.
export function parseRunsArgs(args) {
  const options = { target: null, logs: false, fast: false, limit: null, slowest: null };
  let bareSlowest = false;
  for (const arg of args) {
    if (arg === "--logs") options.logs = true;
    else if (arg === "--fast") options.fast = true;
    else if (arg === "--slowest") {
      options.slowest = DEFAULT_SLOWEST_RUNS;
      bareSlowest = true;
    }
    else if (arg.startsWith("--slowest=")) options.slowest = arg.slice("--slowest=".length);
    else if (arg.startsWith("--limit=")) options.limit = arg.slice("--limit=".length);
    else if (arg.startsWith("-")) return { error: `unknown option \`${arg}\` for \`highball runs\`.` };
    else if (options.target === null) options.target = arg;
  }
  // `--slowest 50` reads as `--slowest=50`: it's how the why-slow skill
  // passes a typed count through. Any other target beside --slowest is a
  // mistake, since the ranking covers many runs, not one.
  if (options.slowest !== null && options.target !== null) {
    if (!bareSlowest || !/^\d+$/.test(options.target)) {
      return { error: "--slowest ranks many runs: give it a count, not a run." };
    }
    options.slowest = options.target;
    options.target = null;
  }
  for (const name of [ "limit", "slowest" ]) {
    if (options[name] === null) continue;
    const n = Number(options[name]);
    if (!Number.isInteger(n) || n < 1) {
      return { error: `--${name}= takes a positive whole number, not \`${options[name]}\`.` };
    }
    options[name] = n;
  }
  return options;
}

// A run number is what the list prints beside a run (#1 is the newest); an
// id is the hex column beside it. Numbers stop at three digits (the journal
// keeps 200 runs) and ids print six wide, so neither reads as the other.
// Numbers shift every time a run lands, including one from another
// worktree of the same project, which shares this journal; an id doesn't.
// Exported for tests.
export function findRun(history, target) {
  if (/^[1-9]\d{0,2}$/.test(target)) {
    const index = Number(target);
    const run = history[index - 1];
    return run ? { run, index } : { error: `no run #${index} (${history.length} recorded).` };
  }
  if (/^[0-9a-f]{4,}$/i.test(target)) {
    const prefix = target.toLowerCase();
    const matches = history
      .map((run, i) => ({ run, index: i + 1 }))
      .filter(({ run }) => typeof run.id === "string" && run.id.toLowerCase().startsWith(prefix));
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) return { error: `no run with id ${target}.` };
    return { error: `${matches.length} runs have ids starting ${target}; give more of it.` };
  }
  return { error: `\`${target}\` is neither a run number nor a run id.` };
}

// Shared column formatter: widths from visible lengths, chosen columns
// right-aligned so numbers and ✓/✗ line up whatever the text does.
function formatRows(rows, rightAligned) {
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((row) => visible(row[col]).length))
  );
  return rows.map((row) =>
    "  " + row
      .map((cell, col) =>
        rightAligned.has(col) ? padStart(cell, widths[col]) : padEnd(cell, widths[col])
      )
      .join("  ")
  );
}

function list(project, history, limit) {
  const shown = history.slice(0, limit);
  console.log(`Recent runs for ${project} (newest first):\n`);
  const rows = shown.map((run, i) => [
    dim(`#${i + 1}`),
    dim(shortId(run)),
    timeAgo(run.started_at),
    run.trigger === "edit" ? "fast" : "full",
    run.branch || "-",
    dim(run.duration_ms != null ? seconds(run.duration_ms) : "-"),
    runLabel(run.status),
    tally(run.results)
  ]);
  const lines = formatRows(rows, new Set([ 5, 6, 7 ]));
  // Group header whenever the work (or session) changes between adjacent
  // runs — contiguous runs with the same prompt are one stretch of work.
  let lastGroup;
  shown.forEach((run, i) => {
    const group = `${run.session ?? ""}·${run.work ?? ""}`;
    if (group !== lastGroup) {
      lastGroup = group;
      if (i > 0) console.log("");
      console.log(dim(`» ${workLabel(run)}`));
    }
    console.log(lines[i]);
  });
  if (shown.length < history.length) {
    console.log(dim(`\nNewest ${shown.length} of ${history.length}. More: highball runs --limit=<n>`));
  }
  console.log(`\nDetail: highball runs <number or id> [--logs]`);
  return 0;
}

function detail(project, run, number, showLogs) {
  const took = run.duration_ms != null ? ` · took ${seconds(run.duration_ms)}` : "";
  const status = runLabel(run.status);
  const id = run.id ? ` (${shortId(run)})` : "";
  console.log(
    `Run #${number}${id} — ${project} · ${run.trigger === "edit" ? "fast checks" : "full suite"}` +
      ` · ${run.branch || "-"} · ${(run.commit || "").slice(0, 7)}` +
      ` · ${timeAgo(run.started_at)} · ${status}${dim(took)}`
  );
  if (run.reported_run_id) console.log(dim(`reported as run ${run.reported_run_id}`));
  console.log("");

  // Same table treatment as the list view: rule rows aligned in
  // columns, output blocks interleaved beneath their rule's row.
  const rows = run.results.map((result) => [
    result.status === "passed" ? green("✓") : result.status === "todo" ? dim("•") : red("✗"),
    result.status === "failed" ? red(result.name) : result.name,
    ruleLabel(result),
    result.duration_ms != null ? dim(seconds(result.duration_ms)) : ""
  ]);
  const lines = formatRows(rows, new Set([ 2, 3 ]));
  run.results.forEach((result, i) => {
    console.log(lines[i]);
    const wantOutput = result.status === "failed" || showLogs;
    if (wantOutput && result.output_tail) {
      console.log(indent(result.output_tail));
    } else if (showLogs && !result.output_tail) {
      console.log(indent(dim("(no output captured)")));
    }
    const rerun = result.status === "failed" ? rerunCommand(result) : null;
    if (rerun) console.log(indent(dim(`rerun by hand: ${rerun}`)));
  });
  if (!showLogs) console.log(dim(`\nAll captured output: highball runs ${number} --logs`));
  return 0;
}

// The command a failed rule ran, for running that one rule again outside
// Highball while fixing it. The journal records it as it ran, through
// `exec.via` when the rule was wrapped. An AI-judged rule's entry is
// `judge <rubric>`, which names the rubric rather than being a command,
// so it has nothing to offer here.
export function rerunCommand(result) {
  const { command } = result;
  if (typeof command !== "string" || command === "" || command.startsWith("judge ")) return null;
  return command;
}

// Exported for tests. Which rules a run's time goes to, over the newest
// `count` finished runs of one kind (full unless `fast`). The share is a
// rule's median against the median run, so rules running side by side
// can add up past 100%. todo rules and rules with no recorded time are
// left out: there is nothing to rank.
export function slowestRules(history, { count = DEFAULT_SLOWEST_RUNS, fast = false } = {}) {
  const trigger = fast ? "edit" : "stop";
  const sample = history
    .filter((run) => run.trigger === trigger && run.status !== "running")
    .slice(0, count);
  const byRule = new Map();
  for (const run of sample) {
    for (const result of run.results || []) {
      if (result.status === "todo" || result.duration_ms == null) continue;
      const key = result.id ?? result.name;
      // Newest first, so the first name seen is the rule's current one.
      const entry = byRule.get(key) ?? { id: key, name: result.name, durations: [], timeouts: 0 };
      entry.durations.push(result.duration_ms);
      if (result.timed_out) entry.timeouts += 1;
      byRule.set(key, entry);
    }
  }
  const runMedian = median(sample.map((run) => run.duration_ms).filter((ms) => ms != null));
  const rules = [ ...byRule.values() ]
    .map(({ id, name, durations, timeouts }) => {
      const typical = median(durations);
      return {
        id, name, runs: durations.length, median_ms: typical, max_ms: Math.max(...durations),
        share: runMedian ? typical / runMedian : null, timeouts
      };
    })
    .sort((a, b) => b.median_ms - a.median_ms);
  return { runs: sample.length, run_median_ms: runMedian, rules };
}

function slowest(project, history, options) {
  const kind = options.fast ? "fast" : "full";
  const report = slowestRules(history, { count: options.slowest, fast: options.fast });
  if (report.rules.length === 0) {
    console.log(`No finished ${kind} runs with timed rules recorded for ${project} yet.`);
    return 0;
  }
  const typical = report.run_median_ms != null ? `, a typical run takes ${seconds(report.run_median_ms)}` : "";
  console.log(
    `Slowest checks for ${project} over the last ${report.runs} ${kind} run${report.runs === 1 ? "" : "s"}` +
      `${typical}:\n`
  );
  const rows = report.rules.map((rule) => [
    rule.name,
    dim(`${rule.runs} run${rule.runs === 1 ? "" : "s"}`),
    `median ${seconds(rule.median_ms)}`,
    dim(`max ${seconds(rule.max_ms)}`),
    rule.share != null ? `${Math.round(rule.share * 100)}% of a run` : "",
    rule.timeouts ? red(`${rule.timeouts} timed out`) : ""
  ]);
  formatRows(rows, new Set([ 1, 2, 3, 4 ])).forEach((line) => console.log(line.trimEnd()));
  const total = report.rules.reduce((sum, rule) => sum + (rule.share ?? 0), 0);
  if (total > 1.05) {
    console.log(dim("\nRules running side by side overlap, so the shares add up past 100%."));
  }
  return 0;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [ ...values ].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function indent(text) {
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

function tally(results) {
  const counts = { passed: 0, failed: 0, todo: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  return [
    counts.passed ? green(`${counts.passed}✓`) : null,
    counts.failed ? red(`${counts.failed}✗`) : null,
    counts.todo ? dim(`${counts.todo} todo`) : null
  ].filter(Boolean).join(" ");
}

function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
