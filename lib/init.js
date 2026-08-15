// `highball init` — scaffolds the .highball/ install unit and the Claude
// Code hooks. Deliberately conservative: it never overwrites an existing
// checks.yml, and it never edits an existing .claude/settings.json (hook
// merging is a human decision — it prints the snippet instead).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const CHECKS_TEMPLATE = (project) => `# ${project}'s Highball rules — the file \`highball run\` reads and
# reports from. \`fast: true\` marks rules cheap enough to run on every
# agent edit; the rest join at turn end. \`todo: true\` declares a rule
# you're committed to but haven't built — tracked on the dashboard,
# never a failure.
version: 1
project: ${project}

# Where runs get reported. The URL is per-team and not a secret, so it
# lives here in committed config; the token never enters the repo — run
# \`highball login\` once per machine (or set HIGHBALL_TOKEN in CI).
# reporting:
#   url: https://your-highball-host

# If this repo's toolchain lives in a container, declare the wrapper once
# and every rule runs through it; rules that belong on the host opt out
# with \`exec: host\`. Omit entirely for host-based setups.
# exec:
#   via: docker compose exec -T app

checks:
  # - id: unit-tests
  #   name: Unit tests
  #   run: npm test

  # - id: lint
  #   name: Lint & formatting
  #   run: npx eslint .
  #   fast: true
`;

// Always the SCOPED command. The unscoped npm name belongs to an unrelated
// package, so a bare `npx highball` in a committed hook is one uninstalled
// checkout away from fetching a stranger's code and running it on every edit.
const HOOKS_JSON = {
  hooks: {
    PostToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [{ type: "command", command: "npx @profoundry-us/highball run --fast" }]
      }
    ],
    Stop: [
      {
        hooks: [{ type: "command", command: "npx @profoundry-us/highball run", timeout: 900 }]
      }
    ]
  }
};

export async function init() {
  const root = process.cwd();
  const project = basename(root);

  mkdirSync(join(root, ".highball"), { recursive: true });

  const checksPath = join(root, ".highball", "checks.yml");
  if (existsSync(checksPath)) {
    console.log(`kept existing ${relative(checksPath, root)}`);
  } else {
    writeFileSync(checksPath, CHECKS_TEMPLATE(project));
    console.log(`created .highball/checks.yml (project: ${project}) — add your rules`);
  }

  const settingsPath = join(root, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    console.log(
      "\n.claude/settings.json already exists — merge these hooks yourself:\n" +
        JSON.stringify(HOOKS_JSON, null, 2)
    );
  } else {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(HOOKS_JSON, null, 2) + "\n");
    console.log("created .claude/settings.json (fast checks on edit, full suite at turn end)");
  }

  console.log(
    "\nnext: fill in .highball/checks.yml, uncomment reporting.url, and run" +
      "\n  highball login   # stores this machine's project token"
  );
  return 0;
}

function relative(path, root) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}
