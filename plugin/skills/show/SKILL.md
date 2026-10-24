---
name: show
description: One Highball run's checks with their timings and failure output, and the command that prints its full logs. Use when asked why a Highball run failed, what a run checked, or how long each check took.
argument-hint: "<run number or id> [--logs]"
allowed-tools:
  - Bash("${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball" runs *)
  - Bash(${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball runs *)
  - Bash(true)
---

Recent Highball runs in this repo, from the journal on this machine:

!`"${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball" runs --limit=10 2>&1 || true`

The run asked for is in the arguments at the end of this skill. If none was
named, show the list above and ask which run to show, by number or id. Don't
guess.

Otherwise run this once with the Bash tool, putting in the run's number or
id, and `--logs` only if it was asked for:

`"${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball" runs <number or id>`

A run is named by a number or a six-character hex id and nothing else. If
the arguments hold anything else, say so and run nothing.

Show what it printed as it is, in a code block. Then:

- For each failed check, name it and quote the line of its output that says
  why. If it has a `rerun by hand:` line, give that command as the way to run
  just that check while fixing it.
- End with the command for every check's full output, using the run's id from
  the first line (or its number when there's no id):
  `node_modules/.bin/highball runs <id> --logs`.

Run numbers count from the newest run and shift whenever a new run lands, so
prefer the id when you refer back to a run.

If the output says the file or directory doesn't exist, there's no
`node_modules/.bin/highball` in `${CLAUDE_PROJECT_DIR}`, the directory Claude
Code started in. If that directory is below the repo root (it has no `.git`),
say Claude Code needs starting at the repo root. Otherwise Highball isn't
installed in this checkout: say so, and point at the repo's own install step.
Never fall back to `npx` or a global `highball`.

Change nothing and start no run: the hooks run the checks. Say a check passed
or failed. Don't call a run a verification, approval or sign-off of the work.
