#!/usr/bin/env node
// The `highball` CLI: a thin dispatcher so each subcommand stays an
// importable, testable module. `run` owns the process exit code — exit 2
// is the contract Claude Code hooks read as "block the agent and feed
// the failure output back".
import { run } from "../lib/run.js";
import { init } from "../lib/init.js";
import { onboard } from "../lib/onboard.js";
import { runs } from "../lib/runs.js";
import { mcp } from "../lib/mcp.js";

const [command, ...args] = process.argv.slice(2);

const USAGE = `highball — hosted checks for local AI development

Usage:
  highball run [--fast]     Run this repo's .highball/checks.yml rules.
                            Exits 2 on failure (blocks Claude Code hooks).
                            --fast runs only rules marked fast: true.
                            --if-changed skips when the working tree is
                            unchanged since the last run (for hooks that
                            also match Bash).
                            Switched off by .highball/disabled (this
                            checkout, gitignored), \`enabled: false\` in
                            checks.yml (committed, whole team), or
                            HIGHBALL_DISABLED=1 (your machine).
  highball init             Scaffold .highball/checks.yml and Claude Code
                            hooks in the current repo.
  highball onboard          Print the setup guide written for this repo's
                            AI agent — tell your agent to run this and
                            follow it.
  highball runs [n]         Local run history (newest first) from
                            ~/.highball/runs. With a number, that run's
                            detail; add --logs for every rule's captured
                            output.
  highball mcp              Serve run history over MCP (stdio), with an
                            MCP Apps dashboard widget for hosts that
                            render them (e.g. Claude Desktop).
`;

switch (command) {
  case "run":
    process.exit(await run(args));
    break;
  case "init":
    process.exit(await init(args));
    break;
  case "onboard":
    process.exit(await onboard(args));
    break;
  case "runs":
    process.exit(await runs(args));
    break;
  case "mcp":
    await mcp();
    break;
  default:
    console.log(USAGE);
    process.exit(command === undefined || command === "--help" ? 0 : 1);
}
