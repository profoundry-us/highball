---
name: why-slow
description: Which Highball checks a run's time goes to, ranked by median and slowest time over recent full runs, with each check's share of a typical run and its timeouts. Use when asked why Highball's turn-end checks are slow, which check takes longest, or where hook time goes.
argument-hint: "[how many recent runs, default 20] [--fast]"
allowed-tools: Bash(${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball runs *)
---

Where this repo's Highball time goes, from the journal on this machine:

!`"${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball" runs --slowest $ARGUMENTS 2>&1 || true`

If the output is a list of runs rather than a "Slowest checks" table, this
project's Highball is older than 0.10, which added the ranking. Say so, say
that upgrading the dev dependency adds it, and stop.

Otherwise show the table as it is, in a code block. Then read
`.highball/checks.yml` and, for the one to three checks that take most of a
run, say which of these levers fits, using the check's own config:

- **It runs the whole suite every turn.** A part that maps to the changed
  files can become a `fast: true` rule scoped to `HIGHBALL_CHANGED_FILES`,
  leaving the full suite for turn end. Highball's own `tests-for-changed`
  check does this.
- **It's independent of the checks around it.** `parallel: true` runs it
  alongside the others, up to `concurrency:` (4 by default), so a run takes
  about as long as its slowest check rather than the sum.
- **It timed out.** Either its budget is dishonest (give it a `timeout:` that
  matches what it really needs) or something in it hangs. The run's detail
  in `/highball:show` has its output.
- **It's a fast check slower than about two seconds.** It runs after every
  edit. Scope it to the changed files, or drop `fast: true` so it runs at
  turn end only.

With `--fast` the table covers fast runs instead, and the last lever is the
one that usually applies.

Recommend; change nothing unless asked. Start no run: the hooks run the
checks. Say a check passed or failed. Don't call a run a verification,
approval or sign-off of the work.
