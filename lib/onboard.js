// `highball onboard` — prints the agent-facing setup guide. The whole
// point of shipping it as a command: any repo's AI agent can be told
// "run `npx highball onboard` and follow it", and the instructions
// arrive versioned with the runner they describe.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function onboard() {
  const path = fileURLToPath(new URL("../ONBOARDING.md", import.meta.url));
  process.stdout.write(readFileSync(path, "utf8"));
  return 0;
}
