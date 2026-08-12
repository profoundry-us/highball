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

// The server may be launched from a repo (project inferable) or from a
// host like Claude Desktop whose cwd is nowhere useful. Resolution order:
// explicit argument, the cwd's checks.yml, then the journal with the
// newest run — the repo being actively worked in IS the current project.
// Journal records carry the repo dir (since runs record process.cwd()),
// so every path out of here can ground the widget's re-run buttons.
function resolveProject(explicit) {
  if (explicit) return { project: explicit, dir: latestDirFor(explicit) };
  try {
    return { project: loadConfig().project, dir: process.cwd() };
  } catch {
    let current = null;
    for (const project of journaledProjects()) {
      const newest = readRuns(project)[0];
      if (!newest) continue;
      if (!current || newest.started_at > current.started_at) {
        current = { project, started_at: newest.started_at };
      }
    }
    if (!current) return { project: null, dir: null };
    return { project: current.project, dir: latestDirFor(current.project) };
  }
}

// Newest journal record that knows its repo dir (older records predate
// the field).
function latestDirFor(project) {
  return readRuns(project).find((run) => run.dir)?.dir ?? null;
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

export function listText(project, runs) {
  if (runs.length === 0) return `No runs recorded for ${project} yet.`;
  const rows = runs.map((run) => [
    `#${run.index}`,
    run.status === "passed" ? "✓ passed" : "✗ FAILED",
    run.trigger === "edit" ? "fast" : "full",
    run.branch || "-",
    run.started_at,
    run.results.map((result) => glyphFor(result.status)).join("")
  ]);
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((row) => row[col].length)));
  return `Runs for ${project} (newest first):\n` + rows.map((row) =>
    "  " + row.map((cell, col) => cell.padEnd(widths[col])).join("  ")).join("\n");
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

  registerAppTool(server, "list_runs", {
    title: "Highball runs",
    description:
      "Recent Highball check runs for a project, from the machine-local " +
      "journal (~/.highball/runs). Renders the runs dashboard widget.",
    inputSchema: {
      project: z.string().optional()
        .describe("Project slug; defaults to the current repo's project")
    },
    _meta: { ui: { resourceUri: DASHBOARD_URI } }
  }, async ({ project: explicit }) => {
    const { project, dir } = resolveProject(explicit);
    if (!project) {
      const known = journaledProjects();
      return reply(
        `No project resolved. Journaled projects: ${known.join(", ") || "(none)"}`,
        { projects: known }
      );
    }
    const runs = readRuns(project).map(summarize);
    return reply(
      uiHost()
        ? `${runs.length} runs for ${project} — rendered in the dashboard widget.`
        : listText(project, runs.slice(0, 20)),
      { project, dir, runs }
    );
  });

  registerAppTool(server, "get_run", {
    title: "Highball run detail",
    description:
      "One Highball run's full detail — per-rule statuses, durations, and " +
      "captured command output. index counts from 1, newest first.",
    inputSchema: {
      index: z.number().int().min(1).describe("1-based index, newest first"),
      project: z.string().optional()
        .describe("Project slug; defaults to the current repo's project")
    },
    _meta: { ui: { resourceUri: DASHBOARD_URI } }
  }, async ({ index, project: explicit }) => {
    const { project, dir } = resolveProject(explicit);
    if (!project) return reply("No project resolved.", {});
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
    // No dir given → the current project's repo (from its journal), so
    // widget-initiated re-runs work from hosts with no useful cwd.
    const cwd = dir || resolveProject(null).dir || process.cwd();
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
