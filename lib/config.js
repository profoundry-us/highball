// Config resolution, kept pure where possible so tests can exercise the
// decision logic without a filesystem.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

export const CONFIG_PATH = ".highball/checks.yml";
export const CREDENTIALS_PATH = join(homedir(), ".highball", "credentials.json");

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
  return config;
}

// The reporting URL is per-team committed config; the token never lives
// in the repo tree: env var (CI) wins, else the machine-local credentials
// file keyed host → project (the .npmrc / gh-hosts pattern, written by
// `highball login`).
export function resolveReporting(config, env = process.env, credentials = readCredentials()) {
  const url = env.HIGHBALL_URL || config.reporting?.url || null;
  const token =
    env.HIGHBALL_TOKEN || (url && credentials?.[url]?.[config.project]) || null;
  return { url, token };
}

// PostHog is the second, independent reporting sink. Unlike the dashboard
// there is no secret to resolve: a PostHog project key is write-only by
// design, so it lives in committed config right next to the host — the same
// posture as `reporting.url`. Env vars still win so CI can point a run
// somewhere else without editing the repo.
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

export function readCredentials(path = CREDENTIALS_PATH) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
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
