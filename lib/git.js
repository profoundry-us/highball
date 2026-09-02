// Git facts about the current checkout, for stamping onto reported runs.
// Never throws: a run outside a repo, or with no commits yet, reports empty
// strings rather than failing the checks.
import { execSync } from "node:child_process";

export function git(command) {
  try {
    return execSync(`${command} 2>/dev/null`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
