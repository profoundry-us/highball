// The AI judge: hands a rubric plus the files this branch touched to
// headless Claude and turns the verdict into the same pass/fail contract
// the deterministic rules use.
//
// This lives in the runner, not in a language pack, because almost none of
// it is language-specific: bundling, the prompt contract, the recursion
// guard, verdict extraction and exit codes are identical whether the repo
// is Rails, Django or Next. Packs own the *rubrics* — the actual opinions,
// which are entirely framework-specific — and declare their language policy
// in rubric front matter. Before this split, a JS-only shop needed Ruby
// installed to run an AI rule, and the recursion guard lived in this file's
// repo while the thing it guarded lived in another.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

// Judging against a narrow rubric is exactly the fast-and-cheap tier's job.
// A rubric that needs deeper reasoning overrides this in its front matter —
// which the previous hardcoded implementation only aspired to.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// Caps the evidence bundle so the judge stays fast and cheap. Anything
// dropped is reported, never silently skipped — a cap that lies reads as
// "covered everything" when it didn't.
const DEFAULT_MAX_BYTES = 48_000;

// Rubrics are markdown with optional YAML front matter:
//
//   ---
//   include: "**/*.rb"
//   exclude: [db/, config/]
//   model: claude-haiku-4-5-20251001
//   ---
//
// Everything after the fence is the rubric prose sent to the judge.
export function parseRubric(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  return { meta: YAML.parse(match[1]) ?? {}, body: text.slice(match[0].length) };
}

// Minimal glob support — `**`, `*`, `?` — rather than a dependency. Rubric
// patterns are file-extension filters in practice ("**/*.rb"), not the kind
// of brace/extglob expressions that would justify pulling in picomatch.
export function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i += 1;
      // `**/` spans zero or more directories; a trailing `**` matches the rest.
      if (pattern[i + 1] === "/") {
        i += 1;
        out += "(?:.*/)?";
      } else {
        out += ".*";
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

// The runner already computed the changed list once (ADR 202608) — the judge
// consumes it rather than shelling out to git again, which is what let the
// old Ruby implementation drift out of step with its own sibling checks.
export function selectFiles(changed, meta = {}, exists = existsSync) {
  const include = [ meta.include ?? "**/*" ].flat().map(globToRegExp);
  const exclude = [ meta.exclude ?? [] ].flat();

  return [ ...new Set(String(changed).split("\n").map((line) => line.trim())) ]
    .filter(Boolean)
    .filter((path) => include.some((pattern) => pattern.test(path)))
    .filter((path) => !exclude.some((prefix) => path.startsWith(prefix)))
    .filter((path) => exists(path));
}

export function buildBundle(files, maxBytes, read) {
  let bundle = "";
  const included = [];
  for (const file of files) {
    const source = read(file);
    if (Buffer.byteLength(bundle) + Buffer.byteLength(source) > maxBytes) break;
    bundle += `\n===== ${file} =====\n${source}`;
    included.push(file);
  }
  return { bundle, included, skipped: files.length - included.length };
}

export function buildPrompt(rubric, bundle) {
  return `You are a code-review judge. Apply ONLY the rubric below to the files
provided. Do not invent rules the rubric does not state. When uncertain,
pass — report only clear violations.

RUBRIC:
${rubric}

Respond with ONLY a JSON object, no markdown fences, in this shape:
{"status":"passed","offenses":[]}
or
{"status":"failed","offenses":[{"file":"path","line":1,"message":"..."}]}

FILES:
${bundle}
`;
}

// Models occasionally wrap the verdict in fences or append a prose recap
// despite the "ONLY a JSON object" instruction — extract the outermost object
// instead of trusting the envelope to be bare JSON.
export function extractVerdict(stdout) {
  let result;
  try {
    result = JSON.parse(stdout).result;
  } catch {
    throw new Error(`AI judge returned unreadable output:\n${stdout}`);
  }
  const json = String(result ?? "").match(/\{[\s\S]*\}/);
  if (!json) throw new Error(`AI judge returned no JSON verdict:\n${result}`);
  try {
    return JSON.parse(json[0]);
  } catch {
    throw new Error(`AI judge returned an unparseable verdict:\n${result}`);
  }
}

// Always runs host-side: it needs the `claude` CLI, which lives on the
// machine rather than in a project's container. Being a runner builtin makes
// that structural instead of an `exec: host` annotation every adopter has to
// remember to write.
export function judge(options) {
  const {
    rubricPath,
    changed,
    spawn = spawnSync,
    exists = existsSync,
    read = (path) => readFileSync(path, "utf8")
  } = options;

  if (!exists(rubricPath)) {
    return { passed: false, output: `rubric not found: ${rubricPath}` };
  }

  const { meta, body } = parseRubric(read(rubricPath));
  const files = selectFiles(changed, meta, exists);
  if (files.length === 0) {
    return { passed: true, output: `AI-judged 0 file(s) against ${rubricPath}` };
  }

  const { bundle, included, skipped } =
    buildBundle(files, meta.max_bytes ?? DEFAULT_MAX_BYTES, read);

  // HIGHBALL_JUDGE guards recursion: the judge session inherits this repo's
  // Claude Code hooks, and the runner exits immediately when it sees this
  // variable — otherwise the judge's own Stop hook would spawn another judge,
  // forever. Guard and guarded now live in the same package.
  const child = spawn(
    "claude",
    [ "-p", "--model", meta.model ?? DEFAULT_MODEL, "--output-format", "json" ],
    {
      input: buildPrompt(body, bundle),
      encoding: "utf8",
      env: { ...process.env, HIGHBALL_JUDGE: "1" },
      maxBuffer: 32 * 1024 * 1024
    }
  );

  if (child.error?.code === "ENOENT") {
    return {
      passed: false,
      output: "AI judge needs the `claude` CLI on PATH, and it wasn't found."
    };
  }
  if (child.status !== 0) {
    return { passed: false, output: `AI judge failed to run: ${child.stderr ?? ""}` };
  }

  let verdict;
  try {
    verdict = extractVerdict(child.stdout ?? "");
  } catch (error) {
    return { passed: false, output: error.message };
  }

  const note = skipped > 0 ? ` (${skipped} file(s) skipped for size)` : "";
  const header = `AI-judged ${included.length} file(s)${note} against ${rubricPath}`;
  const offenses = verdict.offenses ?? [];

  if (verdict.status === "passed" || offenses.length === 0) {
    return { passed: true, output: `${header}\n0 offense(s)` };
  }

  const lines = offenses.map(
    (offense) => `${offense.file}:${offense.line}: ${offense.message}`
  );
  return {
    passed: false,
    output: `${header}\n${lines.join("\n")}\n${offenses.length} offense(s)`
  };
}
