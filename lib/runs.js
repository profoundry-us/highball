// `highball runs [n]` — the no-dashboard view of run history, read from
// the local journal. Bare: a table of recent runs, newest first. With a
// number: that run's detail, including failure output tails.
import { loadConfig } from "./config.js";
import { readRuns, journaledProjects } from "./journal.js";

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
  return index ? detail(project, history, Number(index)) : list(project, history);
}

function list(project, history) {
  console.log(`Recent runs for ${project} (newest first):\n`);
  const rows = history.map((run, i) => [
    `#${i + 1}`,
    timeAgo(run.started_at),
    run.trigger === "edit" ? "fast" : "full",
    run.branch || "-",
    run.status === "passed" ? "✓ passed" : "✗ FAILED",
    tally(run.results)
  ]);
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((row) => row[col].length))
  );
  for (const row of rows) {
    console.log("  " + row.map((cell, col) => cell.padEnd(widths[col])).join("  "));
  }
  console.log(`\nDetail: highball runs <number>`);
  return 0;
}

function detail(project, history, number) {
  const run = history[number - 1];
  if (!run) {
    console.error(`highball: no run #${number} (${history.length} recorded).`);
    return 1;
  }

  const took = run.duration_ms != null ? ` · took ${(run.duration_ms / 1000).toFixed(1)}s` : "";
  console.log(
    `Run #${number} — ${project} · ${run.trigger === "edit" ? "fast checks" : "full suite"}` +
      ` · ${run.branch || "-"} · ${(run.commit || "").slice(0, 7)}` +
      ` · ${timeAgo(run.started_at)} · ${run.status}${took}`
  );
  if (run.reported_run_id) console.log(`reported as run ${run.reported_run_id}`);
  console.log("");

  for (const result of run.results) {
    const glyph = result.status === "passed" ? "✓" : result.status === "todo" ? "•" : "✗";
    const duration = result.duration_ms != null ? ` (${(result.duration_ms / 1000).toFixed(1)}s)` : "";
    console.log(`  ${glyph} ${result.name} — ${result.status}${duration}`);
    if (result.status === "failed" && result.output_tail) {
      console.log(
        result.output_tail
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n")
      );
    }
  }
  return 0;
}

function tally(results) {
  const counts = { passed: 0, failed: 0, todo: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  return [
    counts.passed ? `${counts.passed}✓` : null,
    counts.failed ? `${counts.failed}✗` : null,
    counts.todo ? `${counts.todo} todo` : null
  ].filter(Boolean).join(" ");
}

function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
