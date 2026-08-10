// `highball login` — stores a project token in the machine-local
// credentials file (~/.highball/credentials.json, host → project →
// token). The token is read from stdin with --token-stdin (recommended:
// no shell history, no process listing) or prompted interactively.
// Tokens never touch the repo tree and are never echoed back.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { CREDENTIALS_PATH, loadConfig, readCredentials } from "./config.js";

export async function login(args) {
  const options = parse(args);

  // The local checks.yml, when present, already knows the url + project —
  // don't make the user repeat what the repo declares.
  let config = null;
  try {
    config = loadConfig();
  } catch {
    // Not in a configured repo; url/project must come from flags/prompts.
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const url =
      options.url ||
      config?.reporting?.url ||
      (await rl.question("Highball URL (e.g. https://highball.example.com): "));
    const project =
      options.project || config?.project || (await rl.question("Project slug: "));
    const token = options.tokenStdin
      ? (await readAllStdin()).trim()
      : (await rl.question("Project token (input is visible — prefer --token-stdin): ")).trim();

    if (!url || !project || !token) {
      console.error("highball: url, project, and token are all required.");
      return 1;
    }

    const credentials = readCredentials();
    (credentials[url] ??= {})[project] = token;

    mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2) + "\n");
    chmodSync(CREDENTIALS_PATH, 0o600);

    console.log(`stored token for ${project} @ ${url} in ${CREDENTIALS_PATH}`);
    return 0;
  } finally {
    rl.close();
  }
}

function parse(args) {
  const options = { tokenStdin: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url") options.url = args[++i];
    else if (args[i] === "--project") options.project = args[++i];
    else if (args[i] === "--token-stdin") options.tokenStdin = true;
  }
  return options;
}

async function readAllStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
