// The Claude Code plugin in plugin/, and the marketplace at the repo root
// that lists it. The skills are markdown, so their rules are checked here:
// they read history through the project's own runner and never start a run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import YAML from "yaml";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));
const SKILLS = readdirSync(new URL("../plugin/skills/", import.meta.url));
// The one skill allowed to start a run: setup verifies with the hook
// command itself, once, as onboarding does.
const MAY_RUN = new Set([ "setup" ]);

function skill(name) {
  const text = read(`plugin/skills/${name}/SKILL.md`);
  const [ , front, body ] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  return { front: YAML.parse(front), body };
}

test("the plugin moves with the runner's version", () => {
  const manifest = json("plugin/.claude-plugin/plugin.json");
  assert.equal(manifest.name, "highball");
  assert.equal(manifest.version, json("package.json").version);
});

test("the repo is its own marketplace, listing the plugin by relative path", () => {
  const market = json(".claude-plugin/marketplace.json");
  assert.equal(market.name, "highball", "consumers commit highball@highball; it must not change");
  assert.deepEqual(market.plugins.map(({ name, source }) => ({ name, source })),
    [ { name: "highball", source: "./plugin" } ]);
});

// No hooks: the committed settings.json is the enforcement contract. No
// MCP server: it would hand the model run_checks. No bin/: it would put a
// second, version-skewed runner on PATH.
test("the plugin ships skills and nothing that runs on its own", () => {
  for (const path of [ "hooks", ".mcp.json", "bin", "commands" ]) {
    assert.ok(!existsSync(new URL(`../plugin/${path}`, import.meta.url)), `plugin/${path} must not exist`);
  }
  assert.ok(SKILLS.length > 0);
});

test("every skill is named for its directory and says when it applies", () => {
  for (const name of SKILLS) {
    const { front } = skill(name);
    assert.equal(front.name, name);
    assert.ok(front.description?.length > 40, `${name} needs a description that can trigger it`);
  }
});

test("skills call the project's own runner, never npx", () => {
  for (const name of SKILLS) {
    const { front, body } = skill(name);
    // The one place npx may appear is the line forbidding it.
    assert.doesNotMatch(body.replaceAll("Never fall back to `npx`", ""), /\bnpx\b/,
      `${name} mentions npx other than to forbid it`);
    const injected = [ ...body.matchAll(/!`([^`]+)`/g) ].map((match) => match[1]);
    assert.ok(injected.length > 0, `${name} injects no command`);
    for (const command of injected) {
      assert.match(command, /^"\$\{CLAUDE_PROJECT_DIR\}\/node_modules\/\.bin\/highball" /, `${name}: ${command}`);
      // A non-zero exit aborts the skill, and the error is what the person
      // needs to see.
      assert.match(command, / 2>&1 \|\| true$/, `${name}: ${command}`);
    }
    if (!MAY_RUN.has(name)) {
      assert.equal(front["allowed-tools"], "Bash(${CLAUDE_PROJECT_DIR}/node_modules/.bin/highball runs *)");
    }
  }
});

test("skills that read history never start a run", () => {
  for (const name of SKILLS.filter((skillName) => !MAY_RUN.has(skillName))) {
    const { body } = skill(name);
    for (const command of [ ...body.matchAll(/!`([^`]+)`/g) ].map((match) => match[1])) {
      assert.match(command, /\/highball" runs\b/, `${name} may only call \`highball runs\``);
    }
    assert.doesNotMatch(body, /run_checks/);
  }
});
