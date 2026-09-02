# Highball onboarding — instructions for this repo's AI agent

You are setting up Highball in this repository. Highball gives you (the
agent) guardrails while you work — a checks runner your Claude Code hooks
fire on every edit and turn end, whose exit code 2 blocks you until the
repo's rules pass. Runs can optionally be reported to your human's own
PostHog project. You are configuring the tool that will check your own
future work: set it up so the rules reflect what this repo already trusts,
not what you wish it did.

Work through the steps in order. Steps marked **human** need your human's
input or action — ask, don't guess, and never handle credential values
yourself.

## 0. Preconditions

`npx @profoundry-us/highball --help` must work (Node >= 18, package installed as a dev
dependency). If it doesn't, ask your human whether to install from the npm
registry (`npm install --save-dev @profoundry-us/highball`) or from a
local tarball path they provide. In a repo with no `package.json`, create
a minimal private one first (`{ "name": "<repo>", "private": true }`) and
gitignore `node_modules/` if it isn't already.

**Never run bare `npx highball` where the package is NOT installed**: the
unscoped npm name `highball` belongs to an unrelated package, and npx
would fetch that instead of this runner. Installed locally, the bare name
is safe (npx resolves `node_modules/.bin` first — that's why install is
step 0); for a one-off without installing, use the scoped form,
`npx @profoundry-us/highball <command>`.

## 1. Survey the repo before writing anything

Answer these by reading, not assuming:

- **What languages and toolchains live here**, and which commands does the
  repo *already trust* — look at `package.json` scripts, a `justfile` or
  `Makefile`, CI workflows, README instructions. Wire what exists; invent
  no new tooling in the first pass.
- **Host or container?** Settle this before writing a single rule — see the
  callout immediately below. Getting it wrong makes every rule fail for the
  same uninteresting reason, and it is the most common way this setup
  stalls.
- **What's fast?** Time candidate commands. Only sub-~2s commands belong
  on the per-edit path; test suites belong at turn end; anything needing a
  live server or long setup should not gate turns at all (leave it to the
  repo's existing workflow, or declare it `todo`).

### If the repo's toolchain lives in Docker

Plenty of repos run *everything* through containers — the host may have no
Ruby, no Python, no database at all. Highball handles this, but only if you
declare it. **The runner itself always stays on the host** (that's where the
hooks fire and where the journal lives); only the rule commands move.

Find the dev service and confirm what it actually sees, rather than assuming
the layout:

```bash
docker compose ps --services
docker compose exec -T <service> sh -c 'pwd && ls'
```

Then declare the wrapper once, and every rule runs through it:

```yaml
exec:
  via: docker compose exec -T --workdir /app app
```

Four traps, each of which has bitten a real onboarding:

1. **`-T` is mandatory.** Hook shells have no TTY; without it commands hang
   or die with "the input device is not a TTY".
2. **Set `--workdir`** to wherever the repo is mounted (verify with `pwd`
   above). Containers frequently start somewhere other than the mount root.
3. **Self-orchestrating commands must opt out with `exec: host`.** A
   `just test` / `make test` target that runs its *own* `docker compose
   exec` would otherwise be double-wrapped into nonsense.
4. **Host-only tools opt out too.** If a linter or parser exists on the host
   but not in the image (`node --check` against a JS bundle, say), mark that
   rule `exec: host`.

A stopped container makes every wrapped rule fail. That's correct behavior —
unverifiable is not passing — but say so plainly to your human rather than
quietly dropping the rules.

## 2. Scaffold

Run `npx @profoundry-us/highball init`. It never overwrites: an existing
`.highball/checks.yml` is kept, and if `.claude/settings.json` already
exists it prints the hook snippet for you to merge by hand — merge it
without disturbing existing hooks. Otherwise it creates both files.

## 3. Write `.highball/checks.yml`

Fill the scaffold using what the survey found. A containerized repo looks
like this:

```yaml
version: 1
project: my-mud            # ask your human if their org has slug conventions

# Optional — see step 4. Skip unless your human asks for telemetry.
# reporting:
#   posthog:
#     host: https://us.i.posthog.com   # human provides; committed, not secret
#     project_key: phc_xxx

# Toolchain in Docker: declare the wrapper once. -T is mandatory (hook
# shells have no TTY); --workdir should be the container's repo mount.
exec:
  via: docker compose exec -T --workdir /app mud

checks:
  - id: python-syntax
    name: Game code compiles
    run: python -m compileall -q game
    fast: true                        # sub-2s → runs on every edit

  - id: js-syntax
    name: Web viewer JS parses
    run: node --check web/app.js
    exec: host                        # host tool → opts out of the container
    fast: true

  - id: unit-tests
    name: Unit tests (offline)
    run: just test-unit               # orchestrates its own docker exec
    exec: host                        # → must run on the host

  - id: coverage-ratchet
    name: Coverage never decreases
    todo: true                        # declared aspiration; tracked, never run
```

Decision rules:

- `exec.via` wraps every rule by default; a rule opts out with
  `exec: host` when it invokes a host tool **or** is self-orchestrating
  (a `just`/`make` target that runs `docker compose` itself must not be
  double-wrapped).
- Start minimal: one or two fast syntax/lint rules plus the repo's unit
  test command at turn end. You can grow the ruleset later; a wrong rule
  that blocks every turn erodes trust immediately.
- The runner exports `HIGHBALL_CHANGED_FILES` (newline-separated,
  repo-relative) to every rule — scripts that want changed-only behavior
  can read it instead of shelling out to git.

## 4. Telemetry — **human**, and optional

Highball enforces with no account and no network. Reporting is a separate,
optional decision, and it is your human's to make — ask, do not assume.

If they want it, they add a `reporting.posthog` block to `checks.yml` with
their PostHog host and project key. That key is write-only by design (it is
the same one that ships in client-side web bundles), so it is committed
config, not a secret — there is no login step and no credentials file. If
they would rather not send anything anywhere, skip the block: the local
journal (`highball runs`) already records every run in more detail than
PostHog receives.

## 5. Verify — all four proofs, not just the happy path

1. **Fast path:** `npx @profoundry-us/highball run --fast` exits 0, every rule passed.
2. **Full path:** `npx @profoundry-us/highball run` exits 0 (or fails honestly on real
   pre-existing issues — surface those to your human rather than papering
   over them).
3. **The guardrail:** prove exit 2 works. Create an obviously-temporary
   failing file (e.g. a syntax error in a `tmp_highball_plant.*` file),
   run the fast path, confirm `FAILED` plus exit code 2 plus the failure
   text on stderr — then delete the plant and confirm green again.
4. **The record:** `npx @profoundry-us/highball runs` lists the runs you
   just made, with per-rule status. If your human opted into telemetry,
   each run also prints `reported N events to <host>`; if you see
   `highball posthog reporting skipped: …` instead, check the host and
   project key in `reporting.posthog` and whether this machine can reach
   the host. Reporting never blocks a run, so this is the last thing to
   fix, not the first.

## 6. Report back — **human**

Tell your human, concretely: which rules you wired and why each is
fast/turn-end/todo; what you deliberately did NOT gate (slow suites,
live-server tests); that hooks now block your turns on failures and how
to remove them (`.claude/settings.json`) if they ever need to; and whether
you wired telemetry or left it off. Follow this repo's own norms about
committing the new files — do not commit without being asked.
