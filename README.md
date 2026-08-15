# @profoundry-us/highball

The Highball runner: executes a repo's `.highball/checks.yml` rules, blocks AI
coding agents on failure (exit 2, the Claude Code hook contract), and reports
every run to a Highball dashboard — think "local CI for AI agents": the checks
run and enforce on your machine while the dashboard records what happened.
Enforcement stays local; Highball is the witness and system of record — the
runner never uploads code, only pass/fail plus log tails. Reporting is always
best-effort: no token or no reachable dashboard means checks still run and
block, they just aren't recorded.

## Install

Published releases: `npm install --save-dev @profoundry-us/highball`.

**Always use the scoped name.** The unscoped npm name `highball` belongs to
an unrelated package, so a bare `npx highball` — in a committed hook, a
README, or a one-off — is a single uninstalled checkout away from fetching
a stranger's code and running it.

From a local tarball (pre-release):

```bash
npm pack                                   # in this repo → profoundry-us-highball-<v>.tgz
npm install --save-dev ../highball-runner/profoundry-us-highball-<v>.tgz
```

## Setup: let the repo's own agent do it

Highball is installed *by the AI agent that will be checked by it*. After
installing the package, tell the repo's Claude Code agent:

> Run `npx @profoundry-us/highball onboard` and follow the instructions.

[ONBOARDING.md](ONBOARDING.md) (which that command prints) walks the agent
through surveying the repo's real toolchain, scaffolding, writing rules that
reflect what the repo already trusts, handing the credentials step to the
human, and verifying all four proofs — including that exit 2 actually blocks.

The pieces, for reference or manual setup:

```bash
npx @profoundry-us/highball init    # scaffolds checks.yml + Claude Code hooks
npx @profoundry-us/highball login   # stores a project token (once per machine)
```

`init` never overwrites an existing `checks.yml` and never edits an existing
`.claude/settings.json` (it prints the hook snippet to merge by hand).
`login` writes `~/.highball/credentials.json` (host → project → token, 0600);
pipe the token via `--token-stdin` to keep it out of shell history. CI uses
`HIGHBALL_URL` / `HIGHBALL_TOKEN` env vars instead.

## checks.yml

```yaml
version: 1
project: my-app

reporting:
  url: https://highball.example.com   # per-team, not a secret — committed

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

  - id: coverage-ratchet
    name: Coverage never decreases
    todo: true                         # declared, tracked, not yet built
```

The runner computes the branch's changed-file list once (it owns git) and
hands it to every rule via `HIGHBALL_CHANGED_FILES` — check scripts stay pure
analyzers and need no git in their execution context.

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

The split is capability-driven, not guesswork: the server reads the
client's initialize capabilities (`io.modelcontextprotocol/ui`) — hosts
that render MCP Apps get a short text summary plus the widget; everything
else gets the full picture as aligned plain text. Widget development has
its own harness — `npm run harness`, open http://localhost:3777 — which
plays the host role against the real `assets/dashboard.html` and live
journal data, so widget edits are a reload away instead of a Claude
Desktop restart.

## Run history without a dashboard

Every run also appends to a local journal (`~/.highball/runs/<project>.jsonl`,
pruned to the last 200) — unconditionally, whether or not reporting is
configured. `npx @profoundry-us/highball runs` lists recent runs; adding a
number shows one run's detail with failure output, and `--logs` prints every
rule's captured output, GitHub-Actions-style — the journal keeps the last
10KB per rule, pass or fail, while the dashboard receives failure tails
only. So the runner is self-sufficient out of the box: the hosted
dashboard adds team visibility, history beyond your machine, and
attribution — it's never required to see what happened.

## Roadmap

AI-judged rules (`rubric:` — headless Claude applying a markdown rubric to
changed files) land here as a first-class rule type in a future release.
Built-in generic rules (spec pairing, focused-spec detection, diff budgets)
likewise, along with per-framework starter packs (`highball-rails`,
`highball-python`, `highball-go`) carrying recommended check scripts.
