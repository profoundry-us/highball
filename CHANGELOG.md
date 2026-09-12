# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release dates are the day the version was published to npm.

## [Unreleased]

## [0.7.1] - 2026-09-12

### Fixed

- `--if-changed` keeps one stamp per kind of run (fast, full) instead of one
  per checkout. A fast run's stamp used to satisfy the full run that followed
  it, so in a hooked repo the full-only rules never ran after an edit — the
  fast hook stamped the tree and the Stop hook skipped. Each run now reads its
  own stamp. A full run also refreshes the fast one, since it ran every fast
  rule; a fast run never touches the full one. The full stamp is written only
  on a pass, so a Stop hook that blocked on a red tree blocks again until the
  tree moves. (#24)

### Changed

- `init` scaffolds `--if-changed` on the Stop hook as well, so a turn that
  edited nothing since the last full run skips the suite. Existing installs:
  add the flag to the Stop hook by hand. (#24)

## [0.7.0] - 2026-09-10

### Added

- Per-rule timeouts. Every rule runs under a wall-clock budget: 8s for a
  `fast` rule, 60s otherwise, 300s for an AI-judged rule. Raise a kind for the
  whole repo with a top-level `timeouts:` block (`fast:`, `full:`, `judge:`),
  or one rule with `timeout:`; both are seconds. A rule past its budget is
  killed together with every process it started and fails with a message
  naming the budget it hit. (#21)
- The journal records a run from the moment it starts and rewrites the record
  after every rule, so a run that dies mid-way still shows how far it got. A
  runner stopped by a signal (a hook timeout, a closed terminal, Ctrl-C) kills
  the rule it was in, journals the run as `killed`, and exits 1. The CLI, the
  MCP text and the dashboard widget label `running`, `killed` and `timed out`.
  (#21)
- Publishing a tag now also creates its GitHub release, with notes generated
  from the merged pull requests. 0.7.0 is the first release with a page. (#22)
- This changelog.

### Changed

- `init` writes a 120-second timeout on the fast hook it scaffolds; Claude
  Code's default was ten minutes. (#21)
- The check loop is asynchronous, which is what lets the runner enforce its
  own budgets and respond to signals. Rule output is still captured the same
  way; the AI judge keeps its synchronous spawn and receives the budget as a
  timeout. (#21)
- The onboarding guide tells the agent to install with the package manager
  the repo's lockfile names (yarn, pnpm or npm), and what to do when yarn
  refuses on the repo's own `engines` field. The README lists all three
  install commands. (#18)
- Highball's own fast rule is scoped to changed files: it parses every changed
  JavaScript file and runs the changed modules' unit tests, leaving the suites
  that spawn the CLI to turn end. The README states the targets the budgets
  serve: fast lane under 2s, full suite under 30s. (#21)

### Fixed

- The test suite no longer reports fixture runs to the PostHog project named in
  the developer's environment. (#21)

**Behaviour change for consuming repos:** a `fast: true` rule that takes
longer than 8 seconds now fails as timed out. Give it its own `timeout:`, or
scope it to `HIGHBALL_CHANGED_FILES`.

## [0.6.1] - 2026-09-08

### Changed

- `package.json` carries the homepage, https://highball.profoundry.us, so the
  npm page links to the site. The README links there too. (#16)

## [0.6.0] - 2026-09-04

### Added

- Three ways to switch a repo's checks off, none of them silent: `enabled:
  false` in `checks.yml` for everyone who clones the repo; `HIGHBALL_DISABLED`
  for one machine; and a `.highball/disabled` marker file for one checkout,
  gitignored by the `.highball/.gitignore` that `init` now writes and re-read
  on every run, so it toggles inside a live agent session with no restart.
  Text in the marker comes back as the reason on every run. (#10, #13)
- Continuous integration runs the test suite on pull requests and pushes to
  `main`, on Node 18 and 22. (#11)

### Changed

- `--if-changed` stamps are per checkout rather than per project, so a git
  worktree or a second clone never skips a run because the other one passed.
  (#9)
- `enabled:` accepts only a real boolean; `enabled: no` and `enabled: "false"`
  are errors rather than checks quietly left on. `HIGHBALL_DISABLED=0`,
  `false`, `no`, `off` and empty mean not disabled. (#10)
- The README says when each off switch takes effect, and documents keeping the
  PostHog key in the environment instead of the repo. (#8, #12)

## [0.5.0] - 2026-09-03

### Added

- Runs report to PostHog: `reporting.posthog` in `checks.yml` (or
  `HIGHBALL_POSTHOG_KEY` in the environment) sends one `highball_run` event
  per run and one `highball_check` event per rule, in a single batch after
  the checks finish. The project key is write-only by design, so it is
  committed config with no login step. Dashboard queries ship in
  `docs/posthog-queries.sql`. (#4)
- The fast hook `init` scaffolds matches `Bash` as well as `Write|Edit`, since
  agents in auto mode edit through the shell, and runs with `--if-changed`,
  which fingerprints the working tree and exits at once when nothing moved
  since the last run. (#7)
- The MCP server resolves the current project from its `project` or `dir`
  argument, a `checks.yml` at its working directory, or the client's roots,
  and never falls back to another repo's journal. When none names a repo, the
  widget offers the journaled projects as a picker. (#7)
- A regression test for the stdin deadline, timing the runner process rather
  than the pipeline it sits in. (#3)

### Removed

- The hosted dashboard sink and everything that served it: `highball login`,
  `~/.highball/credentials.json`, `reporting.url`, `HIGHBALL_URL` and
  `HIGHBALL_TOKEN`. Enforcement was always local; the witness half is now a
  PostHog project the team owns. A `checks.yml` still carrying
  `reporting.url` prints a warning on every run and reports nowhere. (#5)

### Changed

- Package metadata points at the renamed repository, profoundry-us/highball.
  (#6)

## [0.4.1] - 2026-08-19

### Fixed

- `zod` is a declared dependency. `lib/mcp.js` imported it while it was only
  present by hoisting, so `highball mcp` failed to start under pnpm, Yarn PnP
  and nohoist layouts. (#2)

## [0.4.0] - 2026-08-15

### Added

- AI-judged rules are a first-class rule type. A rule declares `rubric:`
  instead of `run:`; the runner bundles the changed files the rubric's front
  matter selects, applies it through headless Claude, and returns the same
  pass/fail contract as any other rule. Rubric rules never join a `--fast`
  run, never pass through `exec.via`, and never spawn the model when no
  changed file matches. Packs keep the rubrics; the engine lives here. (#1)

## [0.3.2] - 2026-08-15

### Fixed

- The runner no longer hangs when stdin is open but silent. It read hook
  payloads to EOF, which never returned when invoked from a pipeline that
  neither wrote nor closed; the read now races a 400ms deadline and degrades
  to a run with no session context.
- `bin/highball.js` is marked executable in git, so directory installs work
  as well as tarball installs.

## [0.3.1] - 2026-08-15

### Changed

- `init` scaffolds the scoped command, `npx @profoundry-us/highball`, into
  `.claude/settings.json`. The unscoped name belongs to an unrelated package,
  and a committed hook is the wrong place to leave that ambiguity. Every
  example in the docs is scoped as well, including the MCP registration.
- The onboarding guide's container guidance is its own section, with the
  probes to run and the four traps that had each cost a real onboarding:
  `-T`, `--workdir`, self-orchestrating targets, and host-only tools.

## [0.3.0] - 2026-08-14

### Added

- `highball mcp`: an MCP server over stdio exposing `list_runs`, `get_run` and
  `run_checks`, each carrying an MCP Apps dashboard widget. Hosts that render
  Apps get an interactive run list with click-through detail, expandable
  per-rule output, and re-run buttons; every other host gets the same picture
  as aligned plain text, decided by the client's declared capabilities.
- A widget development harness, `npm run harness`, serving the real dashboard
  against live journal data.
- Every list view shows each run's total duration, and runs are grouped under
  the agent prompt that produced them, read from the hook's transcript.
- The journal records each rule's command, so quiet rules still have
  something to show; rows with nothing to reveal are no longer disclosures.
- Publishing from a pushed `v*` tag through npm trusted publishing (OIDC),
  gated on the tag matching `package.json`, the tests passing, and the
  tarball carrying the widget.

## [0.2.2] - 2026-08-11

Not published to npm.

### Changed

- The run detail view uses the same column formatter as the list.

## [0.2.1] - 2026-08-11

Not published to npm.

### Added

- `highball runs <n> --logs` prints every rule's captured output; the journal
  keeps the last 10KB per rule, pass or fail.

### Changed

- `highball runs` output is colored when writing to a terminal (`NO_COLOR`
  respected, `FORCE_COLOR` overrides), with status columns right-aligned.

## [0.2.0] - 2026-08-11

Not published to npm.

### Added

- A local run journal at `~/.highball/runs/<project>.jsonl`, written on every
  run whether or not reporting is configured and pruned to the last 200 runs,
  and `highball runs` to list recent runs and show one run's detail.

## [0.1.0] - 2026-08-11

### Added

- The runner: `highball run [--fast]` executes the rules in
  `.highball/checks.yml`, prints progress, and exits 2 with the failures on
  stderr, the contract a Claude Code Stop hook reads as "block the agent and
  hand it the output". Rules marked `fast: true` run on every edit; `todo:
  true` declares a rule that is tracked but never fails.
- The execution context: `exec.via` wraps every rule in a declared command
  (a container, say) and a rule opts out with `exec: host`. The runner owns
  git and hands every rule the changed-file list in `HIGHBALL_CHANGED_FILES`.
- `highball init` scaffolds `checks.yml` and the Claude Code hooks, never
  overwriting what exists.
- `highball onboard` prints a setup guide written for the repo's own AI agent.
- `highball login`, for the hosted dashboard of the time.
- MIT license and registry metadata.

[Unreleased]: https://github.com/profoundry-us/highball/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/profoundry-us/highball/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/profoundry-us/highball/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/profoundry-us/highball/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/profoundry-us/highball/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/profoundry-us/highball/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/profoundry-us/highball/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/profoundry-us/highball/compare/de0d5a8...v0.4.0
[0.3.2]: https://github.com/profoundry-us/highball/compare/aa148c1...de0d5a8
[0.3.1]: https://github.com/profoundry-us/highball/compare/e0e54d4...aa148c1
[0.3.0]: https://github.com/profoundry-us/highball/compare/292dbbd...e0e54d4
[0.2.2]: https://github.com/profoundry-us/highball/compare/99d20c1...292dbbd
[0.2.1]: https://github.com/profoundry-us/highball/compare/e123bc7...99d20c1
[0.2.0]: https://github.com/profoundry-us/highball/compare/91c6b6d...e123bc7
[0.1.0]: https://github.com/profoundry-us/highball/commits/91c6b6d
