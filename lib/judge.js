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
import { spawn as spawnChild } from "node:child_process";
import YAML from "yaml";
import { createPool } from "./pool.js";

// Judging against a narrow rubric is exactly the fast-and-cheap tier's job.
// A rubric that needs deeper reasoning overrides this in its front matter —
// which the previous hardcoded implementation only aspired to.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// The most evidence one judge call carries. Past it the files are split
// across several calls, judged concurrently, and their verdicts merged.
// Nothing is dropped: the cap used to stop at the first file that didn't
// fit, and because untracked files come last in the changed list, every
// brand-new file on a branch was skipped while the rule reported a pass.
const DEFAULT_MAX_BYTES = 48_000;

// `files` judges whole files, the historical behaviour. `changed` still
// shows the whole file as context but enforces only on the lines this
// branch touched, the same ratchet the `--changed-only` scripts apply:
// touching one line no longer makes every pre-existing offense in the file
// blocking.
const SCOPES = [ "files", "changed" ];

// Rubrics are markdown with optional YAML front matter:
//
//   ---
//   include: "**/*.rb"
//   exclude: [db/, "**/config/**"]
//   scope: changed
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

// An exclude entry with a glob character is a glob, so `**/config/**`
// reaches an engine's nested config. A plain entry stays a path prefix, so
// every existing rubric's `exclude: [db/, config/]` keeps meaning exactly
// what it meant.
function excludes(entry) {
  if (/[*?]/.test(entry)) {
    const pattern = globToRegExp(entry);
    return (path) => pattern.test(path);
  }
  return (path) => path.startsWith(entry);
}

// The runner already computed the changed list once (ADR 202608) — the judge
// consumes it rather than shelling out to git again, which is what let the
// old Ruby implementation drift out of step with its own sibling checks.
export function selectFiles(changed, meta = {}, exists = existsSync) {
  const include = [ meta.include ?? "**/*" ].flat().map(globToRegExp);
  const exclude = [ meta.exclude ?? [] ].flat().map(excludes);

  return [ ...new Set(String(changed).split("\n").map((line) => line.trim())) ]
    .filter(Boolean)
    .filter((path) => include.some((pattern) => pattern.test(path)))
    .filter((path) => !exclude.some((matches) => matches(path)))
    .filter((path) => exists(path));
}

// Numbered so the judge cites lines it actually saw, and so a `changed`
// scope can check what it cites. Before this the judge guessed line
// numbers from unnumbered source.
export function numberLines(source) {
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}| ${line}`).join("\n") + "\n";
}

export function describeRanges(ranges) {
  return ranges.map(([ start, end ]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ");
}

function section(file, source, ranges) {
  let label = "";
  if (ranges === "all") label = " (new file: every line is changed)";
  else if (Array.isArray(ranges)) label = ranges.length ? ` (changed lines: ${describeRanges(ranges)})` : " (no changed lines)";
  return `\n===== ${file}${label} =====\n${numberLines(source)}`;
}

// Splits the evidence into bundles of at most `maxBytes`, in changed-list
// order. A file bigger than the cap on its own gets a bundle to itself
// rather than being dropped: skipping it would report a pass on code no one
// looked at. `rangesFor` labels each file with its changed lines when the
// rubric is scoped to them.
export function buildBundles(files, maxBytes, read, rangesFor = () => undefined) {
  const bundles = [];
  let current = { text: "", files: [] };
  let oversize = 0;
  for (const file of files) {
    const piece = section(file, read(file), rangesFor(file));
    const size = Buffer.byteLength(piece);
    if (size > maxBytes) oversize += 1;
    if (current.files.length && Buffer.byteLength(current.text) + size > maxBytes) {
      bundles.push(current);
      current = { text: "", files: [] };
    }
    current.text += piece;
    current.files.push(file);
  }
  if (current.files.length) bundles.push(current);
  return { bundles, oversize };
}

export function buildPrompt(rubric, bundle, scoped = false) {
  const scope = scoped
    ? `\nEach file header lists the lines this change touched. Report ONLY
offenses on those lines; everything else predates the change and is
context, not evidence. A file marked "no changed lines" has nothing to
report.\n`
    : "";
  return `You are a code-review judge. Apply ONLY the rubric below to the files
provided. Do not invent rules the rubric does not state. When uncertain,
pass — report only clear violations. Every line is numbered; cite those
numbers.
${scope}
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

// Whether an offense falls on a line the change touched. Anything the
// filter can't place — a file it doesn't know, a line that isn't a number —
// is kept: the scope exists to stop blaming a change for old code, never to
// hide something it can't rule out.
export function withinChanges(offense, rangesFor) {
  const ranges = rangesFor(String(offense.file ?? "").replace(/^\.\//, ""));
  if (ranges === undefined || ranges === "all") return true;
  const line = Number(offense.line);
  if (!Number.isInteger(line)) return true;
  return ranges.some(([ start, end ]) => line >= start && line <= end);
}

const MAX_OUTPUT = 32 * 1024 * 1024;

// One headless Claude call. Asynchronous so the runner can judge several
// bundles — and several rubrics, and slow scripts — at once. Always
// host-side: it needs the `claude` CLI, which lives on the machine rather
// than in a project's container. Its own process group, like every rule
// command, so a timeout or a stopped runner takes the whole CLI down.
//
// HIGHBALL_JUDGE guards recursion: the judge session inherits this repo's
// Claude Code hooks, and the runner exits immediately when it sees this
// variable — otherwise the judge's own Stop hook would spawn another judge,
// forever. Guard and guarded live in the same package.
export function invokeClaude({ prompt, model, timeoutMs, onSpawn }) {
  return new Promise((resolve) => {
    const child = spawnChild("claude", [ "-p", "--model", model, "--output-format", "json" ], {
      env: { ...process.env, HIGHBALL_JUDGE: "1" },
      detached: process.platform !== "win32",
      stdio: [ "pipe", "pipe", "pipe" ]
    });
    onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });

    // The budget for this call. A judge that never answers — a stalled
    // model, a CLI waiting on a login prompt — is a failed rule with a
    // reason, not a hook held open until something else kills it.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32" || !child.pid) child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error, status: null, stdout, stderr, timedOut });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
    // A CLI that dies before reading its prompt closes the pipe; that's
    // reported by its exit, not by an unhandled EPIPE here.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

// What one call amounted to: offenses, a timeout, or an error to report.
function readCall(call, timeoutMs) {
  if (call.timedOut || call.error?.code === "ETIMEDOUT") return { timedOut: true };
  if (call.error?.code === "ENOENT") {
    return { error: "AI judge needs the `claude` CLI on PATH, and it wasn't found." };
  }
  if (call.error) return { error: `AI judge failed to run: ${call.error.message ?? call.error.code}` };
  if (call.status !== 0) return { error: `AI judge failed to run: ${call.stderr ?? ""}`.trim() };
  try {
    const verdict = extractVerdict(call.stdout ?? "");
    return { offenses: verdict.status === "passed" ? [] : verdict.offenses ?? [] };
  } catch (error) {
    return { error: error.message };
  }
}

export async function judge(options) {
  const {
    rubricPath,
    changed,
    timeoutMs,
    // Lazily computed by the runner, which owns git: a map from file to its
    // changed line ranges, or "all" for a new file.
    changedLines = () => new Map(),
    invoke = invokeClaude,
    pool = createPool(),
    onSpawn,
    aborted = () => false,
    exists = existsSync,
    read = (path) => readFileSync(path, "utf8")
  } = options;

  if (!exists(rubricPath)) {
    return { passed: false, output: `rubric not found: ${rubricPath}` };
  }

  const { meta, body } = parseRubric(read(rubricPath));
  const scope = meta.scope ?? "files";
  if (!SCOPES.includes(scope)) {
    return {
      passed: false,
      output: `${rubricPath}: \`scope: ${scope}\` isn't a scope — use \`files\` (the default) or \`changed\`.`
    };
  }

  const files = selectFiles(changed, meta, exists);
  if (files.length === 0) {
    return { passed: true, output: `AI-judged 0 file(s) against ${rubricPath}` };
  }

  const scoped = scope === "changed";
  const lines = scoped ? changedLines() : null;
  const selected = new Set(files);
  const rangesFor = (file) => (scoped && selected.has(file) ? lines.get(file) ?? [] : undefined);
  const { bundles, oversize } = buildBundles(files, meta.max_bytes ?? DEFAULT_MAX_BYTES, read, rangesFor);
  const model = meta.model ?? DEFAULT_MODEL;

  // One budget for the whole rule, however many calls it takes: each call
  // gets what's left of it, including any time spent waiting for a slot.
  const deadline = Date.now() + timeoutMs;
  const calls = await Promise.all(bundles.map((bundle) => pool.run(async () => {
    if (aborted()) return { error: "the runner was stopped before this part was judged" };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { timedOut: true };
    const call = await invoke({ prompt: buildPrompt(body, bundle.text, scoped), model, timeoutMs: remaining, onSpawn });
    return readCall(call, remaining);
  })));

  const offenses = calls.flatMap((call) => call.offenses ?? []);
  const kept = offenses.filter((offense) => withinChanges(offense, rangesFor));
  const ignored = offenses.length - kept.length;
  const errors = [ ...new Set(calls.filter((call) => call.error).map((call) => call.error)) ];
  const unfinished = calls.filter((call) => call.timedOut).length;

  const parts = bundles.length > 1 ? ` in ${bundles.length} parts` : "";
  const notes = [
    scoped ? "changed lines only" : null,
    oversize ? `${oversize} file(s) over max_bytes judged on their own` : null
  ].filter(Boolean);
  const header = `AI-judged ${files.length} file(s)${parts}${notes.length ? ` (${notes.join("; ")})` : ""} against ${rubricPath}`;
  const offenseLines = kept.map((offense) => `${offense.file}:${offense.line}: ${offense.message}`);
  const ignoredLine = ignored ? [ `${ignored} offense(s) outside the changed lines ignored` ] : [];

  if (unfinished) {
    const which = bundles.length > 1 ? ` (${unfinished} of ${bundles.length} parts unfinished)` : "";
    return {
      passed: false,
      timedOut: true,
      output: [ `AI judge gave no verdict within ${timeoutMs / 1000}s${which}.`, ...errors, ...offenseLines ].join("\n")
    };
  }
  if (errors.length) {
    return { passed: false, output: [ header, ...errors, ...offenseLines ].join("\n") };
  }
  if (kept.length === 0) {
    return { passed: true, output: [ header, ...ignoredLine, "0 offense(s)" ].join("\n") };
  }
  return {
    passed: false,
    output: [ header, ...offenseLines, ...ignoredLine, `${kept.length} offense(s)` ].join("\n")
  };
}
