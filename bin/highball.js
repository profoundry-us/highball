#!/usr/bin/env node
// The `highball` CLI: a thin dispatcher so each subcommand stays an
// importable, testable module. `run` owns the process exit code — exit 2
// is the contract Claude Code hooks read as "block the agent and feed
// the failure output back".
import { run } from "../lib/run.js";
import { init } from "../lib/init.js";
import { login } from "../lib/login.js";
import { onboard } from "../lib/onboard.js";
import { runs } from "../lib/runs.js";

const [command, ...args] = process.argv.slice(2);

const USAGE = `highball — hosted checks for local AI development

Usage:
  highball run [--fast]     Run this repo's .highball/checks.yml rules.
                            Exits 2 on failure (blocks Claude Code hooks).
                            --fast runs only rules marked fast: true.
  highball init             Scaffold .highball/checks.yml and Claude Code
                            hooks in the current repo.
  highball login            Store a project token in
                            ~/.highball/credentials.json. Reads the token
                            from stdin with --token-stdin (recommended).
  highball onboard          Print the setup guide written for this repo's
                            AI agent — tell your agent to run this and
                            follow it.
  highball runs [n]         Local run history (newest first) from
                            ~/.highball/runs — no dashboard needed.
                            With a number, that run's full detail.
`;

switch (command) {
  case "run":
    process.exit(await run(args));
    break;
  case "init":
    process.exit(await init(args));
    break;
  case "login":
    process.exit(await login(args));
    break;
  case "onboard":
    process.exit(await onboard(args));
    break;
  case "runs":
    process.exit(await runs(args));
    break;
  default:
    console.log(USAGE);
    process.exit(command === undefined || command === "--help" ? 0 : 1);
}
