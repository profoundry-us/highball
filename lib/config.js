// Config resolution, kept pure where possible so tests can exercise the
// decision logic without a filesystem.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export const CONFIG_PATH = ".highball/checks.yml";

// The per-checkout overlay: a gitignored YAML file beside checks.yml,
// merged over it on every run. It exists for the developer whose checkout
// differs from the team's — the app runs in Docker on this machine and
// on the host on everyone else's — so that difference never has to be
// committed, and never has to sit in `git status` forever as a local edit
// to a tracked file (which is how it ends up committed by accident).
//
// Only these keys may be overridden. The rules themselves are the team's
// decision; the point of a local file is that a checkout can't quietly
// change what is checked, only where and how long it runs and where it
// reports.
export const LOCAL_CONFIG_PATH = ".highball/checks.local.yml";
const LOCAL_KEYS = [ "exec", "timeouts", "reporting" ];

// Loads .highball/checks.yml from the given repo root, with
// checks.local.yml merged over it when present. Throws with a friendly
// message — `highball run` outside a configured repo should read as "set
// me up", not as a stack trace.
export function loadConfig(root = process.cwd()) {
  const config = loadChecks(root);
  const local = loadLocal(root);
  if (!local) return config;

  // `exec` and `reporting` replace the committed block whole: a local
  // `exec: { via: null }` means "no wrapper here", the mirror image of the
  // Docker developer in a host-based repo. `timeouts` merges per field, so
  // raising `full:` locally keeps the team's `fast:` budget.
  const merged = { ...config };
  if ("exec" in local) merged.exec = local.exec;
  if ("reporting" in local) merged.reporting = local.reporting;
  if ("timeouts" in local) merged.timeouts = { ...(config.timeouts ?? {}), ...local.timeouts };
  // Which keys the overlay decided, so the run header can say where the
  // active wrapper came from.
  merged.local = Object.keys(local);
  return merged;
}

function loadLocal(root) {
  const path = join(root, LOCAL_CONFIG_PATH);
  if (!existsSync(path)) return null;
  const local = YAML.parse(readFileSync(path, "utf8"));
  if (local === null || local === undefined) return null;
  if (typeof local !== "object" || Array.isArray(local)) {
    throw new Error(`${LOCAL_CONFIG_PATH} must be a YAML block of ${LOCAL_KEYS.join(", ")}.`);
  }
  // An unknown key is an error rather than a shrug: the file exists to
  // change how this checkout runs, and a misspelt key that silently did
  // nothing would leave the developer believing it had.
  for (const key of Object.keys(local)) {
    if (!LOCAL_KEYS.includes(key)) {
      throw new Error(
        `${LOCAL_CONFIG_PATH}: \`${key}:\` can't be set locally — only ` +
          `${LOCAL_KEYS.join(", ")} can. Rules belong in ${CONFIG_PATH}.`
      );
    }
  }
  if ("exec" in local && local.exec !== null &&
      (typeof local.exec !== "object" || Array.isArray(local.exec))) {
    throw new Error(`${LOCAL_CONFIG_PATH}: \`exec:\` must be a block with \`via:\`, or \`via: null\`.`);
  }
  if ("timeouts" in local) assertTimeouts(local.timeouts, LOCAL_CONFIG_PATH);
  return local;
}

function loadChecks(root) {
  const path = join(root, CONFIG_PATH);
  if (!existsSync(path)) {
    throw new Error(`${CONFIG_PATH} not found — run \`highball init\` first.`);
  }
  const config = YAML.parse(readFileSync(path, "utf8"));
  if (!config?.project) throw new Error(`${CONFIG_PATH} is missing \`project:\`.`);
  // A kill switch that silently fails to kill is the worst of both worlds,
  // so only a real boolean counts and anything else is an error rather than
  // a shrug. `enabled: no` parses as the string "no" under YAML 1.2 and
  // `enabled: "false"` as a string; both are truthy, so a typo would leave
  // the repo running checks its author believed were off.
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error(
      `${CONFIG_PATH}: \`enabled:\` must be true or false, not ` +
        `\`${config.enabled}\` (${typeof config.enabled}).`
    );
  }
  if (!Array.isArray(config.checks)) {
    throw new Error(`${CONFIG_PATH} is missing its \`checks:\` list.`);
  }
  for (const rule of config.checks) {
    if (!rule.run && !rule.rubric && !rule.todo) {
      throw new Error(
        `${CONFIG_PATH}: rule \`${rule.id ?? "(unnamed)"}\` needs ` +
          "`run:`, `rubric:`, or `todo: true`."
      );
    }
    if (rule.timeout !== undefined) {
      assertSeconds(rule.timeout, `rule \`${rule.id ?? "(unnamed)"}\` has \`timeout:\``);
    }
  }
  if (config.timeouts !== undefined) assertTimeouts(config.timeouts, CONFIG_PATH);
  // The dashboard sink is gone; PostHog is the only telemetry path. A repo
  // carrying the old block would otherwise report nowhere and say nothing
  // about it — the same silent-pass shape that makes stale config dangerous.
  if (config.reporting?.url) {
    console.error(
      `highball: ${CONFIG_PATH} has \`reporting.url\`, which is no longer ` +
        "supported. Runs report to PostHog via `reporting.posthog`, or " +
        "nowhere at all. Delete the key to silence this."
    );
  }

  return config;
}

// The per-machine off switch, read fresh on every `highball run` — there is
// no state anywhere, so unsetting the variable re-arms the checks with
// nothing to clean up.
//
// Falsey spellings mean "don't disable" rather than "disable". Plain
// truthiness would make `HIGHBALL_DISABLED=0` stop every check in the repo,
// which is precisely the doubt about whether the guardrail is live that this
// switch exists to remove. Anything else — 1, true, yes, on, or a bare
// value — disables.
const NOT_DISABLED = new Set([ "", "0", "false", "no", "off" ]);

export function disabledByEnv(env = process.env) {
  const value = env.HIGHBALL_DISABLED;
  if (value === undefined) return false;
  return !NOT_DISABLED.has(String(value).trim().toLowerCase());
}

// The per-checkout off switch: an untracked marker file beside checks.yml.
//
// It exists because the other two each miss the common case. `enabled: false`
// is committed, so switching your own checkout off can ship to everyone;
// HIGHBALL_DISABLED is an environment variable, so a hook only sees a change
// after the agent session restarts. This one is per repo, per checkout, and
// re-read on every run like checks.yml — `touch` and `rm`, effective on the
// next run, and `.highball/.gitignore` keeps it out of commits.
export const DISABLED_MARKER = ".highball/disabled";

// Presence is the whole signal; any text inside is the reason, echoed back on
// every run so "why are the checks off in here?" has an answer that outlives
// whoever switched them off.
export function disabledByMarker(root = process.cwd()) {
  const path = join(root, DISABLED_MARKER);
  if (!existsSync(path)) return null;
  try {
    return { reason: readFileSync(path, "utf8").split("\n")[0].trim() };
  } catch {
    // An unreadable marker still counts: it was put there on purpose, and
    // guessing "probably fine, run the checks" is the wrong way to be wrong.
    return { reason: "" };
  }
}

// PostHog is the runner's telemetry sink. There is no secret to resolve: a
// PostHog project key is write-only by design, so it lives in committed
// config right next to the host — no login step, no credentials file. Env
// vars still win so CI can point a run somewhere else without editing the
// repo.
//
// The host defaults to PostHog's US cloud; EU and self-hosted installs set
// it explicitly.
const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";

export function resolvePosthog(config, env = process.env) {
  const posthog = config.reporting?.posthog;
  const key =
    env.HIGHBALL_POSTHOG_KEY || env.POSTHOG_API_KEY || posthog?.project_key || null;
  if (!key) return { host: null, key: null };

  const host =
    env.HIGHBALL_POSTHOG_HOST || env.POSTHOG_HOST || posthog?.host || POSTHOG_DEFAULT_HOST;
  return { host, key };
}

// Wall-clock budgets per rule, in seconds. A fast rule is one worth running
// after every edit, and a rule worth that is one that finishes before the
// agent's next thought — 8s is generous for a lint or a grep and far too
// short for a suite, which is the point: a suite marked fast has to earn
// it with its own `timeout:`. Full rules get a minute by default; teams
// with a long suite raise `timeouts.full` and own the number. AI judges
// wait on a model, so they get their own, longer default.
//
// The budget is what turns a hang into evidence. Without one, a rule that
// never returns holds the hook until Claude Code kills it, and the run is
// journaled nowhere.
export const DEFAULT_TIMEOUTS = { fast: 8, full: 60, judge: 300 };

function assertSeconds(value, where, file = CONFIG_PATH) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${file}: ${where} must be a positive number of seconds, not ` +
        `\`${value}\` (${typeof value}).`
    );
  }
}

function assertTimeouts(timeouts, file) {
  if (typeof timeouts !== "object" || timeouts === null) {
    throw new Error(`${file}: \`timeouts:\` must be a block of fast/full/judge seconds.`);
  }
  for (const [ kind, value ] of Object.entries(timeouts)) {
    if (!(kind in DEFAULT_TIMEOUTS)) {
      throw new Error(
        `${file}: \`timeouts.${kind}\` is not a thing — ` +
          `the kinds are ${Object.keys(DEFAULT_TIMEOUTS).join(", ")}.`
      );
    }
    assertSeconds(value, `\`timeouts.${kind}:\``, file);
  }
}

// Milliseconds a rule may run before the runner kills it: the rule's own
// `timeout:` if it has one, else the default for its kind.
export function timeoutFor(rule, config = {}) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(config.timeouts ?? {}) };
  const seconds = rule.timeout ??
    (rule.rubric ? timeouts.judge : rule.fast ? timeouts.fast : timeouts.full);
  return seconds * 1000;
}

// The execution-context decision (ADR 202608): rule definitions stay
// environment-agnostic; the checkout declares `exec.via` once and every
// rule runs through it unless it opts out with `exec: host`. No declared
// context means everything runs on the host unchanged.
//
// Where the checkout declares it, highest first: HIGHBALL_EXEC_VIA (CI and
// one-off shells — env wins, the way HIGHBALL_DISABLED beats `enabled:`),
// then checks.local.yml, then checks.yml. `source` names which, for the
// run header. An empty env var is unset, not "no wrapper": say that in the
// local file, where `exec: { via: null }` means exactly that.
export function execContext(config, env = process.env) {
  const fromEnv = env.HIGHBALL_EXEC_VIA?.trim();
  if (fromEnv) return { via: fromEnv, source: "HIGHBALL_EXEC_VIA" };
  const via = config.exec?.via || null;
  const source = config.local?.includes("exec") ? LOCAL_CONFIG_PATH : CONFIG_PATH;
  return { via, source: via ? source : null };
}

export function commandFor(rule, config, env = process.env) {
  // Rubric rules never become shell commands: the runner executes them
  // in-process and host-side, because the `claude` CLI lives on the machine
  // rather than in a project's container (see lib/judge.js).
  if (rule.rubric) return null;

  const { via } = execContext(config, env);
  if (!via || rule.exec === "host") return rule.run;
  return `${via} ${rule.run}`;
}
