---
name: setup
description: Set Highball up in this repo, or bring an existing setup up to date. Checks the runner version, the hooks in .claude/settings.json, .highball/.gitignore and the plugin keys, then proposes the edits and applies them on a yes.
argument-hint: ""
disable-model-invocation: true
allowed-tools:
  - Bash("${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball" *)
  - Bash(${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball *)
  - Bash(true)
---

Where Highball stands in this repo:

!`"${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball" runs --limit=1 2>&1 || true`

Work through these steps in order. Report what you find before changing
anything, and change nothing until the person says yes. Touch only
`.claude/settings.json`, `.highball/`, `package.json` and the lockfile.

## 1. The runner is installed

If the output above says the file or directory doesn't exist, the runner
isn't installed in this checkout.

- If `package.json` already lists `@profoundry-us/highball`, the dependencies
  just aren't installed. Say so, and offer the repo's own install (`npm ci`,
  `yarn install`, `pnpm install`, matching the lockfile).
- Otherwise ask whether to add it as a dev dependency, with the package
  manager the lockfile names: `npm install --save-dev`, `yarn add -D` or
  `pnpm add -D` `@profoundry-us/highball`.

Never fall back to `npx` or a global `highball`. Once it's installed, go on.

## 2. A fresh setup follows the onboarding guide

If the output says this isn't a configured repo (no `.highball/checks.yml`),
this is a fresh setup. Run `node_modules/.bin/highball onboard` and follow
that guide instead of the steps below. It covers the rules, the hooks, the
plugin keys and the proofs that they work.

## 3. Audit an existing setup

Report each item as a table row: what you found, and the fix if one is due.

- **Runner version.** Compare the installed version
  (`node_modules/@profoundry-us/highball/package.json`) with
  `npm view @profoundry-us/highball version`. Note an exact pin in
  `package.json`, and keep it exact if you upgrade.
- **Hooks.** In `.claude/settings.json`, each Highball hook should call the
  installed package directly:
  `node node_modules/@profoundry-us/highball/bin/highball.js run …`. Flag any
  that use `npx` or a bare `highball`. The fast hook (`PostToolUse`, matcher
  `Write|Edit|Bash`) carries `--fast --if-changed`. The Stop hook carries
  `--if-changed`. The fast hook belongs only if `.highball/checks.yml` has a
  `fast: true` rule.
- **`.highball/.gitignore`** lists `disabled` and `checks.local.yml`.
- **Plugin keys.** `.claude/settings.json` has
  `extraKnownMarketplaces.highball` and `enabledPlugins["highball@highball"]`.
- **Off switches.** Report a `.highball/disabled` file or `enabled: false` in
  checks.yml. Someone chose those, so never remove them yourself.

## 4. Apply, on a yes

1. To upgrade, use the lockfile's package manager. Then read the
   `CHANGELOG.md` in `node_modules/@profoundry-us/highball/` between the old
   and new version for anything this repo needs to change, and list it.
2. Run `node_modules/.bin/highball init`. It keeps `checks.yml`, adds any
   missing `.gitignore` line, and, since `settings.json` exists, prints the
   current hooks and plugin keys instead of writing them.
3. Merge what it printed into `.claude/settings.json`. Replace Highball's own
   hook entries, keep every other hook and key as it is, and leave the fast
   hook out if there are no fast rules.

## 5. Verify once

Run the Stop hook's command exactly as it now reads in `.claude/settings.json`,
once, and report its result. This is the only run a Highball skill starts. If
it fails on real problems in the repo, report them rather than working around
them.

Commit nothing unless asked. Say a check passed or failed. Don't call a run a
verification, approval or sign-off of the work.
