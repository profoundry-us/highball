// `highball mcp` — a stdio MCP server over the local run journal, with
// an MCP Apps dashboard widget. This is the no-install view layer: hosts
// that support MCP Apps (Claude Desktop et al.) render the widget inline;
// every tool also returns meaningful text, per the extension's graceful-
// degradation rule, so plain MCP hosts lose nothing but the pixels.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { journaledProjects, readRuns } from "./journal.js";

const DASHBOARD_URI = "ui://highball/dashboard.html";
const BIN_PATH = fileURLToPath(new URL("../bin/highball.js", import.meta.url));
const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

// The host decides the server's working directory, and real hosts give it
// nothing useful — Claude Desktop and Claude Code both spawn it at `/`. So
// "the current repo" has to arrive some other way: an explicit `project`
// or `dir` argument, a checks.yml at cwd, or the client's MCP roots.
// Nothing else is guessed. In particular the journal is NOT a fallback:
// "whichever project ran most recently on this machine" is usually some
// other repo, and a widget that silently shows another project's runs
// reads as this project's. Unresolved means the widget offers a picker.
//
// Journal records carry the repo dir (runs record process.cwd()), so an
// explicit project still grounds the widget's re-run buttons. The loaded
// config rides along so per-repo settings (runs_limit) can apply.
export function resolveProject({
  project, dir, cwd = process.cwd(), roots = [], journalDir
} = {}) {
  if (project) {
    const home = dir ?? latestDirFor(project, journalDir);
    return { project, dir: home, config: tryLoad(home) };
  }
  for (const candidate of [ dir, cwd, ...roots ].filter(Boolean)) {
    const config = tryLoad(candidate);
    if (config) return { project: config.project, dir: candidate, config };
  }
  return { project: null, dir: null, config: null };
}

function tryLoad(root) {
  if (!root) return null;
  try {
    return loadConfig(root);
  } catch {
    return null;
  }
}

// Newest journal record that knows its repo dir (older records predate
// the field).
function latestDirFor(project, journalDir) {
  return readRuns(project, journalDir).find((run) => run.dir)?.dir ?? null;
}

// How many runs list_runs returns. 200 journaled runs is a fine history and
// a terrible tool result — the structured payload alone reaches ~300KB,
// which text-only hosts hand straight to the model. Resolution: the call's
// `limit`, then HIGHBALL_RUNS_LIMIT, then `runs_limit:` in checks.yml (only
// present when the project resolved through a repo), then the default.
export const DEFAULT_RUNS_LIMIT = 25;

export function resolveRunsLimit({ limit, env = process.env, config } = {}) {
  for (const candidate of [ limit, env.HIGHBALL_RUNS_LIMIT, config?.runs_limit ]) {
    if (candidate == null || candidate === "") continue;
    const n = Number(candidate);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_RUNS_LIMIT;
}

// List payloads stay lean — output tails ride only on get_run.
function summarize(run, i) {
  return {
    index: i + 1,
    started_at: run.started_at,
    duration_ms: run.duration_ms,
    trigger: run.trigger,
    branch: run.branch,
    commit: run.commit,
    status: run.status,
    session: run.session ?? null,
    work: run.work ?? null,
    reported_run_id: run.reported_run_id,
    results: (run.results || []).map(({ id, name, status, duration_ms }) =>
      ({ id, name, status, duration_ms }))
  };
}

function reply(text, structuredContent) {
  return { content: [ { type: "text", text } ], structuredContent };
}

// --- text rendering ------------------------------------------------------
// Two audiences: hosts that advertised the MCP Apps UI capability get a
// short summary (the widget carries the detail), everyone else gets the
// full picture as aligned plain text — the extension's graceful-
// degradation rule made concrete. Exported for tests.

const glyphFor = (status) =>
  status === "passed" ? "✓" : status === "todo" ? "•" : "✗";

export function listText(project, runs, total = runs.length) {
  if (runs.length === 0) return `No runs recorded for ${project} yet.`;
  const scope = total > runs.length
    ? `, last ${runs.length} of ${total} — raise with limit, HIGHBALL_RUNS_LIMIT, ` +
      "or runs_limit in checks.yml"
    : "";
  const rows = runs.map((run) => [
    `#${run.index}`,
    run.status === "passed" ? "✓ passed" : "✗ FAILED",
    run.trigger === "edit" ? "fast" : "full",
    run.branch || "-",
    run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : "-",
    run.started_at,
    run.results.map((result) => glyphFor(result.status)).join("")
  ]);
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((row) => row[col].length)));
  const lines = [ `Runs for ${project} (newest first${scope}):` ];
  let lastGroup;
  runs.forEach((run, i) => {
    // Group header whenever the work (or its session) changes between
    // adjacent runs — the journal is chronological, so contiguous runs
    // with the same prompt are one stretch of work.
    const group = `${run.session ?? ""}·${run.work ?? ""}`;
    if (group !== lastGroup) {
      lastGroup = group;
      lines.push(run.work ? `» ${run.work}` : "» (no session context)");
    }
    lines.push("  " + rows[i].map((cell, col) => cell.padEnd(widths[col])).join("  "));
  });
  return lines.join("\n");
}

export function detailText(project, index, run) {
  const took = run.duration_ms != null
    ? ` · took ${(run.duration_ms / 1000).toFixed(1)}s` : "";
  const rules = run.results.map((result) => {
    const duration = result.duration_ms != null
      ? ` (${(result.duration_ms / 1000).toFixed(1)}s)` : "";
    let line = `  ${glyphFor(result.status)} ${result.name} — ${result.status}${duration}`;
    if (result.status === "failed" && result.output_tail) {
      line += "\n" + result.output_tail.split("\n").map((l) => `      ${l}`).join("\n");
    }
    return line;
  }).join("\n");
  return `Run #${index} — ${project} · ${run.trigger === "edit" ? "fast checks" : "full suite"}` +
    ` · ${run.branch || "-"} · ${(run.commit || "").slice(0, 7)} · ${run.status}${took}\n${rules}`;
}

export async function mcp() {
  const server = new McpServer({ name: "highball", version: VERSION });

  // Did this client advertise MCP Apps support in its initialize
  // capabilities (io.modelcontextprotocol/ui)? Checked at call time —
  // capabilities aren't known yet when tools are registered.
  const uiHost = () => {
    const capability = getUiCapability(server.server.getClientCapabilities());
    return !!capability &&
      (!capability.mimeTypes || capability.mimeTypes.includes(RESOURCE_MIME_TYPE));
  };

  // The client's MCP roots are the one thing a host can tell us about
  // which repo is open. Best-effort: only asked of clients that advertise
  // the capability, and a slow or failing answer resolves to nothing.
  const clientRoots = async () => {
    try {
      if (!server.server.getClientCapabilities()?.roots) return [];
      const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
      return roots
        .map((root) => root.uri)
        .filter((uri) => uri.startsWith("file:"))
        .map((uri) => fileURLToPath(uri));
    } catch {
      return [];
    }
  };

  const projectArg = z.string().optional().describe(
    "Project slug. Defaults to the repo at `dir`, at the server's cwd, or " +
    "at the client's MCP roots; when none has a .highball/checks.yml the " +
    "result lists journaled projects to choose from instead of guessing."
  );
  const dirArg = z.string().optional().describe(
    "Repo root containing .highball/checks.yml. Pass the current working " +
    "directory when calling from inside a repo."
  );

  registerAppTool(server, "list_runs", {
    title: "Highball runs",
    description:
      "Recent Highball check runs for a project, from the machine-local " +
      `journal (~/.highball/runs). Newest ${DEFAULT_RUNS_LIMIT} by default. ` +
      "Renders the runs dashboard widget.",
    inputSchema: {
      project: projectArg,
      dir: dirArg,
      limit: z.number().int().min(1).optional().describe(
        `Max runs to return, newest first (default ${DEFAULT_RUNS_LIMIT}; ` +
        "HIGHBALL_RUNS_LIMIT or runs_limit in checks.yml also override)"
      )
    },
    _meta: { ui: { resourceUri: DASHBOARD_URI } }
  }, async ({ project: explicit, dir: explicitDir, limit }) => {
    const { project, dir, config } =
      resolveProject({ project: explicit, dir: explicitDir, roots: await clientRoots() });
    if (!project) {
      const known = journaledProjects();
      return reply(
        "No project resolved: no .highball/checks.yml at the working " +
          "directory or the client's roots. Pass `project` or `dir`. " +
          `Journaled projects: ${known.join(", ") || "(none)"}`,
        { projects: known }
      );
    }
    const history = readRuns(project);
    const max = resolveRunsLimit({ limit, config });
    const runs = history.slice(0, max).map(summarize);
    return reply(
      uiHost()
        ? `${runs.length} of ${history.length} runs for ${project} — ` +
          "rendered in the dashboard widget."
        : listText(project, runs, history.length),
      { project, dir, runs, total: history.length, limit: max }
    );
  });

  registerAppTool(server, "get_run", {
    title: "Highball run detail",
    description:
      "One Highball run's full detail — per-rule statuses, durations, and " +
      "captured command output. index counts from 1, newest first.",
    inputSchema: {
      index: z.number().int().min(1).describe("1-based index, newest first"),
      project: projectArg,
      dir: dirArg
    },
    _meta: { ui: { resourceUri: DASHBOARD_URI } }
  }, async ({ index, project: explicit, dir: explicitDir }) => {
    const { project, dir } =
      resolveProject({ project: explicit, dir: explicitDir, roots: await clientRoots() });
    if (!project) return reply("No project resolved — pass `project` or `dir`.", {});
    const history = readRuns(project);
    const run = history[index - 1];
    if (!run) return reply(`No run #${index} (${history.length} recorded).`, {});
    return reply(
      uiHost()
        ? `Run #${index} for ${project}: ${run.status} — rendered in the dashboard widget.`
        : detailText(project, index, run),
      { project, dir, run: { ...summarize(run, index - 1), results: run.results } }
    );
  });

  registerAppTool(server, "run_checks", {
    title: "Run Highball checks",
    description:
      "Execute a repo's Highball checks (fast rules or the full suite). " +
      "Blocks until done; the run lands in the journal and, when reporting " +
      "is configured, on the dashboard.",
    inputSchema: {
      dir: z.string().optional()
        .describe("Repo root containing .highball/checks.yml; defaults to cwd"),
      fast: z.boolean().optional().describe("Only rules marked fast: true")
    },
    _meta: { ui: { resourceUri: DASHBOARD_URI } }
  }, async ({ dir, fast }) => {
    // The widget passes the dir it was grounded with, so re-runs work from
    // hosts with no useful cwd; otherwise resolve the same way list_runs
    // does and let the child's own error explain a missing checks.yml.
    const cwd = dir || resolveProject({ roots: await clientRoots() }).dir || process.cwd();
    const child = spawnSync(
      process.execPath,
      [ BIN_PATH, "run", ...(fast ? [ "--fast" ] : []) ],
      { cwd, encoding: "utf8", timeout: 900_000, env: { ...process.env, NO_COLOR: "1" } }
    );
    const output = `${child.stdout || ""}${child.stderr || ""}`.slice(-4000);
    let project = null;
    let latest = null;
    try {
      project = loadConfig(cwd).project;
      latest = readRuns(project)[0] || null;
    } catch {
      // No checks.yml at cwd — the child's own error output says so.
    }
    return reply(
      `exit ${child.status}\n${output}`,
      {
        project,
        dir: cwd,
        exitCode: child.status,
        run: latest ? { ...summarize(latest, 0), results: latest.results } : null
      }
    );
  });

  registerAppResource(server, "Highball Dashboard", DASHBOARD_URI, {}, async () => ({
    contents: [ {
      uri: DASHBOARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: readFileSync(new URL("../assets/dashboard.html", import.meta.url), "utf8")
    } ]
  }));

  await server.connect(new StdioServerTransport());
}
