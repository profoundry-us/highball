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

Install before running anything: with the package in `node_modules`, the
short `npx highball …` form resolves to this runner's binary. Without it,
bare `npx highball` would fetch the unrelated unscoped `highball` package
from the registry — for uninstalled one-offs, always use the scoped form
(`npx @profoundry-us/highball <command>`).

From a local tarball (pre-release):

```bash
npm pack                                   # in this repo → profoundry-us-highball-<v>.tgz
npm install --save-dev ../highball-runner/profoundry-us-highball-<v>.tgz
```

## Setup: let the repo's own agent do it

Highball is installed *by the AI agent that will be checked by it*. After
installing the package, tell the repo's Claude Code agent:

> Run `npx highball onboard` and follow the instructions.

[ONBOARDING.md](ONBOARDING.md) (which that command prints) walks the agent
through surveying the repo's real toolchain, scaffolding, writing rules that
reflect what the repo already trusts, handing the credentials step to the
human, and verifying all four proofs — including that exit 2 actually blocks.

The pieces, for reference or manual setup:

```bash
npx highball init    # scaffolds .highball/checks.yml + Claude Code hooks
npx highball login   # stores this machine's project token (once per machine)
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

## Roadmap

AI-judged rules (`rubric:` — headless Claude applying a markdown rubric to
changed files) land here as a first-class rule type in a future release.
Built-in generic rules (spec pairing, focused-spec detection, diff budgets)
likewise, along with per-framework starter packs (`highball-rails`,
`highball-python`, `highball-go`) carrying recommended check scripts.
