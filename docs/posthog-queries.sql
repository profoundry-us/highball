-- Dashboard queries for the PostHog sink (lib/posthog.js).
--
-- Kept here because a PostHog dashboard is UI state: it drifts, it can't be
-- reviewed, and it can't be rebuilt after someone deletes a tile. These are
-- the source of truth. Paste one into the SQL editor and "Save as insight",
-- or open it directly with:
--
--   https://<host>/project/<id>/sql#q=<url-encoded query>
--
-- The event schema they read is documented in the README; the short version
-- is `highball_run` once per run and `highball_check` once per rule result,
-- with run context repeated on every check event because PostHog has no join
-- back to a run.
--
-- Backfilled events (from `highball runs` journals) carry `imported: true`
-- and have a null runner_version. Add `AND properties.imported != true` to
-- any query that should see live data only.


-- 1. RULE COST VS. BENEFIT
-- The tile that decides whether a rule stays. Sorted by total time spent, so
-- the top row is the rule costing the most agent-wait. A rule with zero
-- failures and a large total_min is a latency tax, not a gate: delete it,
-- or move it off `fast:` so it only runs at turn end.
SELECT properties.project AS repo,
       properties.rule_id AS rule,
       count() AS runs,
       countIf(properties.status = 'failed') AS failures,
       round(countIf(properties.status = 'failed') / count() * 100, 1) AS fail_pct,
       round(avg(toFloat(properties.duration_ms)), 0) AS avg_ms,
       round(sum(toFloat(properties.duration_ms)) / 60000, 1) AS total_min
FROM events
WHERE event = 'highball_check' AND properties.status != 'todo'
GROUP BY repo, rule
ORDER BY total_min DESC
LIMIT 12;


-- 2. FAILURE RATE BY WEEK
-- Are the changed-files ratchets actually draining? A flat line means the
-- backlog is being re-touched rather than fixed. A falling line is the
-- ratchet working as designed.
SELECT toStartOfWeek(timestamp) AS week,
       count() AS checks,
       countIf(properties.status = 'failed') AS failures,
       round(countIf(properties.status = 'failed') / count() * 100, 2) AS fail_pct
FROM events
WHERE event = 'highball_check' AND properties.status != 'todo'
GROUP BY week
ORDER BY week;


-- 3. FAST-PATH LATENCY
-- Scoped to trigger = 'edit', so this is only what the agent waits for on
-- EVERY edit. p95 matters more than the mean here: the slow tail is what
-- gets noticed. Anything over a second or so wants justifying.
SELECT properties.project AS repo,
       properties.rule_id AS rule,
       count() AS edit_runs,
       round(quantile(0.95)(toFloat(properties.duration_ms)), 0) AS p95_ms,
       round(avg(toFloat(properties.duration_ms)), 0) AS avg_ms
FROM events
WHERE event = 'highball_check'
  AND properties.trigger = 'edit'
  AND properties.status != 'todo'
GROUP BY repo, rule
ORDER BY p95_ms DESC
LIMIT 12;


-- 4. REPO HEALTH
-- Adoption and outcome per repo. The edit/stop split is the useful column:
-- roughly 1:1 is normal, because agent edits batch into turns. A repo with
-- almost no `stop` runs has a Stop hook that isn't firing.
SELECT properties.project AS repo,
       count() AS runs,
       countIf(properties.status = 'failed') AS failed,
       round(countIf(properties.status = 'failed') / count() * 100, 1) AS fail_pct,
       countIf(properties.trigger = 'edit') AS edit_runs,
       countIf(properties.trigger = 'stop') AS stop_runs,
       round(avg(toFloat(properties.duration_ms)) / 1000, 1) AS avg_sec,
       max(timestamp) AS last_run
FROM events
WHERE event = 'highball_run'
GROUP BY repo
ORDER BY runs DESC;


-- 5. TODO DEBT
-- Rules declared in checks.yml with `todo: true` — committed to, never
-- built. They can never fail a run, so without this tile they are invisible
-- and stay that way. times_skipped is how many runs went past them.
SELECT properties.project AS repo,
       properties.rule_id AS rule,
       count() AS times_skipped,
       max(timestamp) AS last_seen
FROM events
WHERE event = 'highball_check' AND properties.status = 'todo'
GROUP BY repo, rule
ORDER BY times_skipped DESC;
