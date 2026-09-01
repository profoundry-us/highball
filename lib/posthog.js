// The second reporting sink: PostHog. Where lib/report.js talks to a
// Highball dashboard over a bespoke API, this speaks PostHog's batch
// capture endpoint, so a team can reuse analytics they already run
// instead of hosting a server for this.
//
// The whole run leaves in ONE request. The dashboard protocol opens a
// run, POSTs each result, then PATCHes the status — twenty round trips
// for an eighteen-rule run. PostHog events are immutable and
// append-only, which suits a runner that already defers all reporting
// to after the checks finish: nothing to open, nothing to finalize.
//
// Best-effort, like all reporting: failures warn and return. A dead
// analytics endpoint must never block an agent.
import { hostname, userInfo } from "node:os";
import { git } from "./report.js";

const TIMEOUT_MS = 15_000;

// Two event types, and deliberately no third. `highball_run` answers
// "how are runs doing" and `highball_check` answers "which rules are
// earning their keep"; every question we set out to ask breaks down
// from one of those.
export const RUN_EVENT = "highball_run";
export const CHECK_EVENT = "highball_check";

// Returns true when the batch was accepted, false when reporting was
// skipped or failed — the caller journals either way.
export async function reportPosthog({
  host, key, project, results, hook, fastOnly, startedAt, durationMs, branch,
  commitSha, version
}) {
  try {
    const batch = buildEvents({
      project, results, hook, fastOnly, startedAt, durationMs, branch, commitSha,
      version, distinctId: distinctId()
    });

    const response = await fetch(new URL("/batch/", host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, batch }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (response.status >= 300) {
      throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    console.log(`reported ${batch.length} events to ${new URL(host).host}`);
    return true;
  } catch (error) {
    console.error(`highball posthog reporting skipped: ${error.message}`);
    return false;
  }
}

// Pure, so the event shape can be tested without a network or a clock.
export function buildEvents({
  project, results, hook, fastOnly, startedAt, durationMs, branch, commitSha,
  version, distinctId
}) {
  const timestamp = startedAt.toISOString();
  const trigger = fastOnly ? "edit" : "stop";
  const sessionKey =
    hook?.session_id || process.env.HIGHBALL_SESSION_KEY || `manual-${hostname()}`;

  // Repeated on every event rather than joined at query time. PostHog has
  // no joins back to a "run" table, so a breakdown like "failure rate by
  // rule, on this branch only" needs branch to sit on the check event
  // itself.
  const shared = {
    project,
    branch,
    commit: commitSha,
    trigger,
    session_key: sessionKey,
    agent: hook?.session_id ? "claude-code" : "manual",
    runner_version: version,
    // PostHog surfaces these in its UI as the sending client.
    $lib: "highball",
    $lib_version: version
  };

  const failed = results.filter((result) => !result.passed);
  const todo = results.filter((result) => result.todo);

  const events = [ {
    event: RUN_EVENT,
    distinct_id: distinctId,
    timestamp,
    properties: {
      ...shared,
      status: failed.length === 0 ? "passed" : "failed",
      duration_ms: durationMs,
      rules_total: results.length,
      rules_passed: results.length - failed.length - todo.length,
      rules_failed: failed.length,
      rules_todo: todo.length,
      // The denominator for any "how often does rule X fail" question that
      // spans runs whose rulesets differ.
      rules_run: results.map((result) => result.rule.id),
      failed_rules: failed.map((result) => result.rule.id)
    }
  } ];

  for (const result of results) {
    events.push({
      event: CHECK_EVENT,
      distinct_id: distinctId,
      timestamp,
      properties: {
        ...shared,
        rule_id: result.rule.id,
        rule_name: result.rule.name,
        status: result.todo ? "todo" : result.passed ? "passed" : "failed",
        duration_ms: result.durationMs,
        // A one-line summary, never the log tail. Multi-kilobyte blobs in
        // event properties bloat the column store and slow every query that
        // touches it; the full output is already on disk in the journal.
        summary: summarize(result),
        command:
          result.rule.run ?? (result.rule.rubric ? `judge ${result.rule.rubric}` : null)
      }
    });
  }

  return events;
}

function summarize(result) {
  if (result.todo) return "planned — not implemented yet";
  if (result.passed) return null;
  return result.output.split("\n").find((line) => line.trim())?.trim().slice(0, 120) ?? null;
}

// Who the run belongs to. The git identity is the one that means anything
// across machines — the same person on a laptop and a devcontainer should
// be one person — with the machine as the fallback when git has no
// identity configured (CI images, fresh containers).
export function distinctId(env = process.env) {
  if (env.HIGHBALL_POSTHOG_DISTINCT_ID) return env.HIGHBALL_POSTHOG_DISTINCT_ID;
  const email = git("git config user.email");
  if (email) return email;
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return `host-${hostname()}`;
  }
}
