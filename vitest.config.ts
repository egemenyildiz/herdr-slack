import { defineConfig } from "vitest/config";

// Coverage thresholds are the committed target — see AGENTS.md "Testing".
//
// The ramp: the global gate is live from the first real module. The 100% per-file
// gate on slack/guards.ts activates when that file appears — a file that does not
// exist yet cannot be at 100%, and a red bar on day one just teaches everyone to
// lower the numbers.
export default defineConfig({
  test: {
    include: ["app/test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["app/src/**/*.ts"],
      exclude: [
        "app/src/**/types.ts",
        "app/src/cli.ts",
        "app/src/index.ts",
        // Interactive TTY utilities: an infinite render loop that exits on
        // SIGINT, and a recorder whose entire job is a side effect. Both are
        // developer tools, not product logic — the projection they display is
        // what carries the tests.
        "app/src/dev/**",
        // The daemon entrypoint: wiring plus a promise that never resolves.
        // Every part it composes (config, lock, tail, projection, budget) is
        // tested on its own; an "is it wired up" test here would assert the
        // shape of main() rather than any behaviour.
        "app/src/daemon/run.ts",
        // A Bolt passthrough that needs a live Socket Mode connection to
        // exercise. The logic worth testing was deliberately kept out of it —
        // isActionableMessage and isPinnedTeam live in slack/transport.ts and
        // are covered there, including the message_changed feedback loop.
        "app/src/slack/socket-transport.ts",
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        // The security boundary: allowlist, team pinning, ref resolution,
        // throttle. Anything less than 100% here is a hole, so this gate is
        // live now that the file exists (it landed in M1 rather than M3).
        "app/src/slack/guards.ts": {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
