// Config resolution, kept pure where possible so tests can exercise the
// decision logic without a filesystem.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export const CONFIG_PATH = ".highball/checks.yml";

// Loads .highball/checks.yml from the given repo root. Throws with a
// friendly message — `highball run` outside a configured repo should read
// as "set me up", not as a stack trace.
export function loadConfig(root = process.cwd()) {
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
  }
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

// The execution-context decision (ADR 202608): rule definitions stay
// environment-agnostic; the checkout declares `exec.via` once and every
// rule runs through it unless it opts out with `exec: host`. No declared
// context means everything runs on the host unchanged.
export function commandFor(rule, config) {
  // Rubric rules never become shell commands: the runner executes them
  // in-process and host-side, because the `claude` CLI lives on the machine
  // rather than in a project's container (see lib/judge.js).
  if (rule.rubric) return null;

  const via = config.exec?.via;
  if (!via || rule.exec === "host") return rule.run;
  return `${via} ${rule.run}`;
}
