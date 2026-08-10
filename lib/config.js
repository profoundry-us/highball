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

export function readCredentials(path = CREDENTIALS_PATH) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

// The execution-context decision (ADR 202608): rule definitions stay
// environment-agnostic; the checkout declares `exec.via` once and every
// rule runs through it unless it opts out with `exec: host`. No declared
// context means everything runs on the host unchanged.
export function commandFor(rule, config) {
  const via = config.exec?.via;
  if (!via || rule.exec === "host") return rule.run;
  return `${via} ${rule.run}`;
}
