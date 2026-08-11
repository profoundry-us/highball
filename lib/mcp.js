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
  registerAppResource, registerAppTool, RESOURCE_MIME_TYPE
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
// host like Claude Desktop whose cwd is nowhere useful — so `project` is
// always overridable, and when nothing resolves we can still answer with
// the list of journaled projects.
function resolveProject(explicit) {
  if (explicit) return { project: explicit, dir: null };
  try {
    return { project: loadConfig().project, dir: process.cwd() };
  } catch {
    const known = journaledProjects();
    return { project: known.length === 1 ? known[0] : null, dir: null };
  }
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

function runLine(run) {
  const tally = run.results.map((result) =>
    result.status === "passed" ? "✓" : result.status === "todo" ? "•" : "✗").join("");
  return `#${run.index} ${run.status} · ${run.trigger} · ${run.branch || "-"} · ${run.started_at} ${tally}`;
}

function reply(text, structuredContent) {
  return { content: [ { type: "text", text } ], structuredContent };
}

export async function mcp() {
  const server = new McpServer({ name: "highball", version: VERSION });

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
      `${runs.length} runs for ${project} (newest first):\n` +
        runs.slice(0, 20).map(runLine).join("\n"),
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
    const text = run.results.map((result) =>
      `${result.status === "passed" ? "✓" : result.status === "todo" ? "•" : "✗"} ` +
      `${result.name} — ${result.status}` +
      (result.status === "failed" && result.output_tail ? `\n${result.output_tail}` : "")
    ).join("\n");
    return reply(
      `Run #${index} for ${project}: ${run.status}\n${text}`,
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
    const cwd = dir || process.cwd();
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
