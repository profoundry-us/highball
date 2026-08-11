// `highball runs [n] [--logs]` — the no-dashboard view of run history,
// read from the local journal. Bare: a table of recent runs, newest
// first. With a number: that run's detail — failure output by default,
// every rule's captured output with --logs.
import { loadConfig } from "./config.js";
import { readRuns, journaledProjects } from "./journal.js";

// TTY-gated ANSI (NO_COLOR respected, FORCE_COLOR overrides) — hook
// shells and pipes get plain text.
const COLORS_ON = process.env.FORCE_COLOR
  ? true
  : Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const paint = (code, text) => (COLORS_ON ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (text) => paint("32", text);
const red = (text) => paint("31;1", text);
const dim = (text) => paint("2", text);

// Column math must use what the eye sees, not what the terminal parses.
const visible = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const padEnd = (text, width) => text + " ".repeat(Math.max(0, width - visible(text).length));
const padStart = (text, width) => " ".repeat(Math.max(0, width - visible(text).length)) + text;

export async function runs(args) {
  let project;
  try {
    project = loadConfig().project;
  } catch {
    const known = journaledProjects();
    console.error(
      "highball: not inside a configured repo (no .highball/checks.yml)."
    );
    if (known.length > 0) {
      console.error(`Projects with local history: ${known.join(", ")}`);
    }
    return 1;
  }

  const history = readRuns(project);
  if (history.length === 0) {
    console.log(`No local runs recorded for ${project} yet — run \`highball run\`.`);
    return 0;
  }

  const index = args.find((arg) => /^\d+$/.test(arg));
  return index
    ? detail(project, history, Number(index), args.includes("--logs"))
    : list(project, history);
}

function list(project, history) {
  console.log(`Recent runs for ${project} (newest first):\n`);
  const rows = history.map((run, i) => [
    dim(`#${i + 1}`),
    timeAgo(run.started_at),
    run.trigger === "edit" ? "fast" : "full",
    run.branch || "-",
    run.status === "passed" ? green("✓ passed") : red("✗ FAILED"),
    tally(run.results)
  ]);
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((row) => visible(row[col]).length))
  );
  // Status and tally sit right-aligned at the row's end so the ✓/✗
  // columns line up no matter how branch names vary.
  const RIGHT_ALIGNED = new Set([ 4, 5 ]);
  for (const row of rows) {
    const cells = row.map((cell, col) =>
      RIGHT_ALIGNED.has(col) ? padStart(cell, widths[col]) : padEnd(cell, widths[col])
    );
    console.log("  " + cells.join("  "));
  }
  console.log(`\nDetail: highball runs <number> [--logs]`);
  return 0;
}

function detail(project, history, number, showLogs) {
  const run = history[number - 1];
  if (!run) {
    console.error(`highball: no run #${number} (${history.length} recorded).`);
    return 1;
  }

  const took = run.duration_ms != null ? ` · took ${(run.duration_ms / 1000).toFixed(1)}s` : "";
  const status = run.status === "passed" ? green("passed") : red("FAILED");
  console.log(
    `Run #${number} — ${project} · ${run.trigger === "edit" ? "fast checks" : "full suite"}` +
      ` · ${run.branch || "-"} · ${(run.commit || "").slice(0, 7)}` +
      ` · ${timeAgo(run.started_at)} · ${status}${dim(took)}`
  );
  if (run.reported_run_id) console.log(dim(`reported as run ${run.reported_run_id}`));
  console.log("");

  for (const result of run.results) {
    const glyph =
      result.status === "passed" ? green("✓") : result.status === "todo" ? dim("•") : red("✗");
    const name = result.status === "failed" ? red(result.name) : result.name;
    const duration =
      result.duration_ms != null ? dim(` (${(result.duration_ms / 1000).toFixed(1)}s)`) : "";
    console.log(`  ${glyph} ${name} — ${result.status}${duration}`);

    const wantOutput = result.status === "failed" || showLogs;
    if (wantOutput && result.output_tail) {
      console.log(indent(result.output_tail));
    } else if (showLogs && !result.output_tail) {
      console.log(indent(dim("(no output captured)")));
    }
  }
  if (!showLogs) console.log(dim(`\nAll captured output: highball runs ${number} --logs`));
  return 0;
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
