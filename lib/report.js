// The witness half: best-effort reporting to the Highball app — open
// run, per-check results, finalize. Payloads mirror the Ruby
// proto-runner exactly so the ingestion API sees one dialect. Failures
// here warn and return; they NEVER fail the checks.
import { execSync } from "node:child_process";
import { hostname } from "node:os";

// Returns the server's run id on success, null when reporting was
// skipped or failed — the caller journals it either way.
export async function report({ url, token, rules, results, hook, fastOnly, startedAt, branch, commitSha }) {
  try {
    const base = new URL(url);
    const request = async (method, path, body) => {
      const response = await fetch(new URL(path, base), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
      });
      if (response.status >= 300) {
        throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
      }
      return response.json();
    };

    const opened = await request("POST", "/api/v1/runs", {
      agent: hook.session_id ? "claude-code" : "manual",
      session_key:
        hook.session_id || process.env.HIGHBALL_SESSION_KEY || `manual-${hostname()}`,
      trigger: fastOnly ? "edit" : "stop",
      branch,
      commit_sha: commitSha,
      rules_snapshot: rules,
      started_at: startedAt.toISOString()
    });
    const runId = opened.run_id;

    for (const result of results) {
      await request("POST", `/api/v1/runs/${runId}/results`, {
        check_key: result.rule.id,
        name: result.rule.name,
        status: result.todo ? "todo" : result.passed ? "passed" : "failed",
        duration_ms: result.durationMs,
        // Full logs stay local; the tail is enough to read a failure on
        // the dashboard without shipping megabytes per keystroke.
        log_tail: result.passed ? null : result.output.slice(-4000),
        summary: result.todo
          ? "planned — not implemented yet"
          : result.passed
            ? null
            : result.output.split("\n")[0]?.trim().slice(0, 120)
      });
    }

    await request("PATCH", `/api/v1/runs/${runId}`, {
      status: results.every((result) => result.passed) ? "passed" : "failed"
    });
    console.log(`reported to ${base.host} (run ${runId})`);
    return runId;
  } catch (error) {
    console.error(`highball reporting skipped: ${error.message}`);
    return null;
  }
}

export function git(command) {
  try {
    return execSync(`${command} 2>/dev/null`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
