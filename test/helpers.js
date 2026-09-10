// The environment the end-to-end tests hand to the CLI they spawn. It
// inherits the developer's shell, minus anything that would make a
// fixture run behave like a real one: the PostHog key from
// ~/.claude/settings.json used to ride along, so every fixture run in the
// suite posted its events to the real project and paid a network round
// trip for it — a quarter of the suite's wall time, and a stream of
// "disabled-fixture" runs in the telemetry. Same for the machine-wide off
// switch, which would turn every fixture into a no-op.
export function cliEnv(extra = {}) {
  return {
    ...process.env,
    HIGHBALL_POSTHOG_KEY: "",
    POSTHOG_API_KEY: "",
    HIGHBALL_DISABLED: "",
    ...extra
  };
}
