---
name: list
description: Recent Highball check runs in this repo, newest first, grouped by the prompt that triggered them, with each run's number, id, age, fast or full, duration and result. Use when asked what Highball ran, whether the checks passed, or what the hooks did recently.
allowed-tools:
  - Bash("${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball" runs *)
  - Bash(${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball runs *)
  - Bash(true)
---

Highball's run history for this repo, from the journal on this machine:

!`"${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball" runs --limit=25 2>&1 || true`

Show the output above as it is, in a code block. Then add one line: the newest
run's result and, if it failed, which checks failed. Point at `/highball:show`
with that run's id for the detail.

If the output says the file or directory doesn't exist, there's no
`node_modules/.bin/highball` in `${CLAUDE_PROJECT_DIR}`, the directory
Claude Code started in. If that directory has no `package.json` and one
above it does, it is below the repo root: say Claude Code needs starting at
the repo root, where the runner is and where the hooks in
`.claude/settings.json` load. Otherwise Highball isn't installed in this
checkout: say so, and point at the repo's own install step (`npm ci`,
`yarn install`, `pnpm install`). Never fall back to `npx` or a global
`highball`. If it says this isn't a configured repo, this repo doesn't use Highball.

If the list runs past 25 runs or has no id column, this project's Highball is
older than 0.10. Show the newest 25 and say that upgrading the dev dependency
adds ids and a shorter list.

Change nothing and start no run: the hooks run the checks. Say a check passed
or failed. Don't call a run a verification, approval or sign-off of the work.
