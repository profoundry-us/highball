#!/usr/bin/env node
// The `highball` CLI: a thin dispatcher so each subcommand stays an
// importable, testable module. `run` owns the process exit code — exit 2
// is the contract Claude Code hooks read as "block the agent and feed
// the failure output back".
//
// Each subcommand is imported when it is asked for, not up front. The
// hooks call `run` after every agent tool call, and most of those calls
// skip; loading the MCP server (and the SDK behind it) for a run that
// exits in a few milliseconds roughly doubled the cost of every skip.

const [command, ...args] = process.argv.slice(2);

const USAGE = `highball — hosted checks for local AI development

Usage:
  highball run [--fast]     Run this repo's .highball/checks.yml rules.
                            Exits 2 on failure (blocks Claude Code hooks).
                            --fast runs only rules marked fast: true.
                            --if-changed skips when the working tree is
                            unchanged since the last run of the same kind
                            (fast or full), so hooks that fire on every
                            command or every turn end stay cheap.
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
  case "run": {
    const { run } = await import("../lib/run.js");
    process.exit(await run(args));
    break;
  }
  case "init": {
    const { init } = await import("../lib/init.js");
    process.exit(await init(args));
    break;
  }
  case "onboard": {
    const { onboard } = await import("../lib/onboard.js");
    process.exit(await onboard(args));
    break;
  }
  case "runs": {
    const { runs } = await import("../lib/runs.js");
    process.exit(await runs(args));
    break;
  }
  case "mcp": {
    const { mcp } = await import("../lib/mcp.js");
    await mcp();
    break;
  }
  default:
    console.log(USAGE);
    process.exit(command === undefined || command === "--help" ? 0 : 1);
}
