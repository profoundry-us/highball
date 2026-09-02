# @profoundry-us/highball

The Highball runner: executes a repo's `.highball/checks.yml` rules and blocks
AI coding agents on failure (exit 2, the Claude Code hook contract) — "local
CI for AI agents". Enforcement is entirely local and needs no account, no
network, and no configuration beyond `checks.yml`.

Runs can optionally be reported to PostHog for team-wide visibility. That is
the witness half, and it is deliberately somebody else's server: you point at
your own PostHog project, so Highball never takes custody of your data. The
runner never uploads code — only rule ids, pass/fail, durations, and a
one-line summary of a failure. Reporting is always best-effort: an unreachable
endpoint means checks still run and still block, they just aren't recorded.

## Install

Published releases: `npm install --save-dev @profoundry-us/highball`.

**Always use the scoped name.** The unscoped npm name `highball` belongs to
an unrelated package, so a bare `npx highball` — in a committed hook, a
README, or a one-off — is a single uninstalled checkout away from fetching
a stranger's code and running it.

From a local tarball (pre-release):

```bash
npm pack                                   # in this repo → profoundry-us-highball-<v>.tgz
npm install --save-dev ../highball/profoundry-us-highball-<v>.tgz
```

## Setup: let the repo's own agent do it

Highball is installed *by the AI agent that will be checked by it*. After
installing the package, tell the repo's Claude Code agent:

> Run `npx @profoundry-us/highball onboard` and follow the instructions.

[ONBOARDING.md](ONBOARDING.md) (which that command prints) walks the agent
through surveying the repo's real toolchain, scaffolding, writing rules that
reflect what the repo already trusts, and verifying all four proofs —
including that exit 2 actually blocks.

The pieces, for reference or manual setup:

```bash
npx @profoundry-us/highball init    # scaffolds checks.yml + Claude Code hooks
```

`init` never overwrites an existing `checks.yml` and never edits an existing
`.claude/settings.json` (it prints the hook snippet to merge by hand). There
is no login step: the only credential Highball takes is a PostHog project
key, which is write-only by design and lives in committed config.

## checks.yml

```yaml
version: 1
project: my-app
# runs_limit: 25   # rows the MCP widget / list_runs return; HIGHBALL_RUNS_LIMIT overrides

reporting:
  url: https://highball.example.com   # per-team, not a secret — committed

  # Optional second sink, independent of the one above. Either, both, or
  # neither may be configured.
  posthog:
    host: https://us.i.posthog.com    # EU cloud or self-hosted also fine
    project_key: phc_xxx              # write-only by design — committed

# Containerized toolchain? Declare the wrapper once and every rule runs
# through it; rules opt out with `exec: host`. Rule definitions stay
# environment-agnostic on purpose — the *where* is per-checkout config.
exec:
  via: docker compose exec -T app

checks:
  - id: unit-tests
    name: Unit tests
    run: bundle exec rspec spec        # runs through exec.via

  - id: js-syntax
    name: Playback JS parses
    run: node --check web/app.js
    exec: host                         # host-side tool, opts out
    fast: true                         # cheap → runs on every agent edit

  - id: architecture-quality
    name: Architecture & naming (AI)
    rubric: .highball/packs/rails/rubrics/architecture.md

  - id: coverage-ratchet
    name: Coverage never decreases
    todo: true                         # declared, tracked, not yet built
```

The runner computes the branch's changed-file list once (it owns git) and
hands it to every rule via `HIGHBALL_CHANGED_FILES` — check scripts stay pure
analyzers and need no git in their execution context.

## AI-judged rules

A rule with `rubric:` instead of `run:` is judged by headless Claude rather
than by a script: the runner bundles the changed files the rubric asks for,
applies the rubric, and turns the verdict into the same pass/fail contract
every other rule uses.

The rubric is markdown with optional YAML front matter, which carries the only
language-specific part:

```markdown
---
include: "**/*.rb"          # default: every changed file
exclude: [db/, config/]     # path prefixes
model: claude-haiku-4-5-20251001
---

A comment VIOLATES this rubric when it restates what the code already says.
```

Three properties are enforced by the runner rather than left to each repo:

- **Never on the fast path.** Rubric rules are dropped from `--fast` runs even
  if marked `fast: true` — otherwise you pay model latency on every edit.
- **Always host-side.** The judge needs the `claude` CLI, so `exec.via` never
  wraps it and no `exec: host` annotation is required.
- **No evidence, no call.** When nothing in the changed set matches `include`,
  the rule passes without spawning the model at all.

Rubrics live with the opinions they express: a framework pack such as
`@profoundry-us/highball-rails` ships them, and the runner supplies the engine.

## Reporting to PostHog (optional)

`reporting.posthog` sends runs to PostHog — the runner's only telemetry path.
A team that already runs PostHog needs no server for this, and a team that
doesn't can skip the block entirely and use the local journal. The project key
is write-only by design, so it is committed config: no login step, no
credentials file. `HIGHBALL_POSTHOG_KEY` / `HIGHBALL_POSTHOG_HOST` (or
`POSTHOG_API_KEY` / `POSTHOG_HOST`) override it for CI.

The whole run leaves in ONE request to `/batch/`. PostHog events are
immutable, which suits a runner that already defers reporting to after the
checks finish.

Two event types per run:

| event | one per | key properties |
| --- | --- | --- |
| `highball_run` | run | `status`, `duration_ms`, `rules_passed/failed/todo`, `rules_run[]`, `failed_rules[]` |
| `highball_check` | rule result | `rule_id`, `rule_name`, `status`, `duration_ms`, `summary`, `command` |

Run context (`project`, `branch`, `commit`, `trigger`, `session_key`,
`runner_version`) is repeated on every event rather than joined at query time,
because PostHog has no join back to a run: a breakdown like "failure rate by
rule, on this branch only" needs `branch` on the check event itself.
`rules_run[]` is the denominator for any per-rule rate that spans runs whose
rulesets differ.

Log tails are never sent — multi-kilobyte blobs in event properties bloat the
column store and slow every query that touches it. Failures carry a one-line
`summary`; the full output stays in the local journal (below).

Volume is smaller than "runs on every edit" suggests, because agent edits
batch into turns. Measured across 842 real runs on one developer's machine
over 18 active days and 9 projects: a median of 22 runs/day, `edit` and `stop`
runs at close to 1.3:1, and ~15k events/month/dev at the model above.

Dashboard queries live in [docs/posthog-queries.sql](docs/posthog-queries.sql)
— rule cost vs. benefit, failure rate by week, fast-path latency, repo health,
and todo debt. They are versioned rather than left as PostHog UI state, which
drifts and cannot be reviewed.

Events are attributed to `git config user.email`, falling back to
`user@hostname` when git has no identity (CI images, fresh containers).
`HIGHBALL_POSTHOG_DISTINCT_ID` overrides it.

## The MCP dashboard widget

`highball mcp` serves the journal over MCP (stdio) with three tools —
`list_runs`, `get_run`, `run_checks` — and an
[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) widget:
in hosts that render Apps (Claude Desktop and friends), asking about your
checks produces an interactive inline dashboard — click a run for per-rule
detail with expandable command output, re-run fast or full checks from a
button. In hosts without Apps support the same tools answer in plain text,
per the extension's graceful-degradation rule. Register it with the scoped
name — hosts spawn the server from an arbitrary directory, so it resolves
from the registry rather than a local install:

```json
"highball": { "command": "npx", "args": ["-y", "@profoundry-us/highball", "mcp"] }
```

The journal it reads is machine-global (`~/.highball/runs/`), so one
registration covers every repo on that machine — there is no per-repo MCP
setup.

Which project the widget shows is never guessed. Hosts spawn the server with
no useful working directory (Claude Desktop and Claude Code both use `/`), so
`list_runs` resolves the project from its `project` or `dir` argument, a
`.highball/checks.yml` at the server's cwd, or the client's MCP roots. When
none of those names a repo it returns the journaled projects for the widget
to offer as a picker, rather than showing whichever repo happened to run most
recently. An agent calling from inside a repo should pass `dir`.

`list_runs` returns the newest 25 runs, and the widget says so at the top.
Change it per call with `limit`, per machine with `HIGHBALL_RUNS_LIMIT`, or
per repo with `runs_limit:` in checks.yml.

The split is capability-driven, not guesswork: the server reads the
client's initialize capabilities (`io.modelcontextprotocol/ui`) — hosts
that render MCP Apps get a short text summary plus the widget; everything
else gets the full picture as aligned plain text. Widget development has
its own harness — `npm run harness`, open http://localhost:3777 — which
plays the host role against the real `assets/dashboard.html` and live
journal data, so widget edits are a reload away instead of a Claude
Desktop restart.

## Run history, with no telemetry at all

Every run appends to a local journal (`~/.highball/runs/<project>.jsonl`,
pruned to the last 200) — unconditionally, whether or not reporting is
configured. `npx @profoundry-us/highball runs` lists recent runs; adding a
number shows one run's detail with failure output, and `--logs` prints every
rule's captured output, GitHub-Actions-style.

The journal is the richer of the two records: it keeps the last 10KB per rule
pass or fail, while PostHog gets a one-line summary and no logs at all. So the
runner is fully self-sufficient with no `reporting:` block — PostHog adds
cross-developer trends, not visibility you'd otherwise lack.

## Roadmap

Built-in generic rules (spec pairing, focused-spec detection, diff budgets)
land here in a future release, along with more per-framework starter packs
(`highball-python`, `highball-go`) carrying recommended check scripts. The
Rails pack ([`@profoundry-us/highball-rails`](https://github.com/profoundry-us/highball-rails))
and AI-judged `rubric:` rules have shipped.
