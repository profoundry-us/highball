// `highball init` — scaffolds the .highball/ install unit and the Claude
// Code hooks. Deliberately conservative: it never overwrites an existing
// checks.yml, and it never edits an existing .claude/settings.json (hook
// merging is a human decision — it prints the snippet instead).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const CHECKS_TEMPLATE = (project) => `# ${project}'s Highball rules — the file \`highball run\` reads and
# reports from. \`fast: true\` marks rules cheap enough to run on every
# agent edit; the rest join at turn end. \`todo: true\` declares a rule
# you're committed to but haven't built — tracked in run history,
# never a failure.
version: 1
project: ${project}

# Set \`enabled: false\` to switch this repo's checks off for everyone,
# without deleting rules or hooks. To switch them off only in YOUR
# checkout, leave this alone and \`touch .highball/disabled\` instead —
# it is gitignored, and takes effect on the next run.

# Optional telemetry. The PostHog project key is write-only by design, so
# it is committed config — there is no login step and no credentials file.
# To keep it out of the repo instead, set HIGHBALL_POSTHOG_KEY in the
# environment (e.g. the env block of ~/.claude/settings.json) and leave
# this block out entirely.
# reporting:
#   posthog:
#     host: https://us.i.posthog.com
#     project_key: phc_your_key

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
//
// The fast hook matches Bash as well as the edit tools: agents in auto mode
// edit through Bash, and a hook on Write|Edit alone never fires for them.
// --if-changed keeps the Bash firings free when the tree hasn't moved.
const HOOKS_JSON = {
  hooks: {
    PostToolUse: [
      {
        matcher: "Write|Edit|Bash",
        hooks: [{
          type: "command",
          command: "npx @profoundry-us/highball run --fast --if-changed"
        }]
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

  // Ignore the `disabled` marker from inside .highball/ rather than by
  // editing the repo's root .gitignore, which init doesn't own. It is
  // committed, so every clone inherits the protection and nobody has to
  // remember the setup step that keeps a local switch-off local.
  const ignorePath = join(root, ".highball", ".gitignore");
  if (existsSync(ignorePath)) {
    console.log("kept existing .highball/.gitignore");
  } else {
    writeFileSync(ignorePath, "# A local, uncommitted `highball run` off switch.\ndisabled\n");
    console.log("created .highball/.gitignore (keeps the `disabled` marker out of commits)");
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
    "\nnext: fill in .highball/checks.yml, and optionally uncomment the" +
      "\nreporting.posthog block to send runs to PostHog."
  );
  return 0;
}

function relative(path, root) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}
