import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultInstance, writeConfigFile } from "../../src/config/config.js";
import { formatReport, runDoctor } from "../../src/config/doctor.js";
import { currentPlatform } from "../../src/daemon/service.js";

/** A fetch that answers Slack calls from a lookup table. */
function stubFetch(responses: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const method = String(url).split("/api/")[1] ?? "";
    const body = responses[method] ?? { ok: false, error: "unknown_method" };
    return { json: async () => body, status: 200 } as Response;
  }) as unknown as typeof fetch;
}

/**
 * The platform doctor will look under. Installing a unit for the other one
 * leaves doctor correctly reporting "no service installed", which passed on
 * macOS and failed on Linux.
 */
const here = currentPlatform() ?? "linux";

describe("doctor", () => {
  let dir: string;
  let file: string;

  const instance = () =>
    defaultInstance({
      label: "personal",
      herdrSocketPath: "/tmp/definitely-absent.sock",
      slack: { botToken: "xoxb-1", appToken: "xapp-1", teamId: "T1", appId: "A1", botUserId: "U1" },
      allowedUsers: ["U1"],
    });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-doctor-"));
    file = path.join(dir, "config.json");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  });

  const run = (responses: Record<string, unknown> = {}) =>
    runDoctor({
      instance: "default",
      configFile: file,
      fetchImpl: stubFetch(responses),
      home: dir,
    });

  it("stops early and explains when there is no config at all", async () => {
    const report = await runDoctor({ instance: "default", configFile: file, offline: true });
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: "config", state: "fail" });
    expect(report.checks[0]?.fix).toContain("setup");
  });

  it("fails a world-readable config with a chmod fix", async () => {
    writeConfigFile({ version: 1, instances: { default: instance() } }, file);
    chmodSync(file, 0o644);
    const report = await run();
    expect(report.checks[0]?.fix).toContain("chmod 600");
  });

  it("names an unconfigured instance", async () => {
    writeConfigFile({ version: 1, instances: { default: instance() } }, file);
    const report = await runDoctor({ instance: "sess-work", configFile: file, offline: true });
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.name === "instance" && c.state === "fail")).toBe(true);
  });

  it("treats an empty allowlist as a failure, and says why it matters", async () => {
    writeConfigFile(
      { version: 1, instances: { default: { ...instance(), allowedUsers: [] } } },
      file,
    );
    const report = await run({ "auth.test": { ok: true, team_id: "T1" } });
    const check = report.checks.find((c) => c.detail.includes("allowedUsers"));
    expect(check?.state).toBe("fail");
    expect(check?.fix).toContain("shell");
    expect(report.ok).toBe(false);
  });

  it("catches a token pasted from the wrong workspace", async () => {
    writeConfigFile({ version: 1, instances: { default: instance() } }, file);
    const report = await run({
      "auth.test": { ok: true, team_id: "T_OTHER", team: "Other Corp" },
      "apps.connections.open": { ok: true, url: "wss://x" },
    });
    const check = report.checks.find((c) => c.name === "slack team");
    expect(check?.state).toBe("fail");
    expect(check?.detail).toContain("T_OTHER");
  });

  it("maps a missing scope to a reinstall link", async () => {
    writeConfigFile({ version: 1, instances: { default: instance() } }, file);
    const report = await run({
      "auth.test": { ok: false, error: "missing_scope" },
      "apps.connections.open": { ok: true, url: "wss://x" },
    });
    const check = report.checks.find((c) => c.name === "slack bot token");
    expect(check?.state).toBe("fail");
    expect(check?.fix).toContain("A1/install-on-team");
  });

  it("rejects an app token that cannot actually open a socket", async () => {
    // A well-formed xapp- prefix proves nothing; only the handshake does.
    writeConfigFile({ version: 1, instances: { default: instance() } }, file);
    const report = await run({
      "auth.test": { ok: true, team_id: "T1" },
      "apps.connections.open": { ok: false, error: "invalid_auth" },
    });
    const check = report.checks.find((c) => c.name === "slack app token");
    expect(check?.state).toBe("fail");
    expect(check?.fix).toContain("connections:write");
  });

  it("warns rather than fails when herdr is simply not running", async () => {
    // The daemon outlives herdr by design, so this must not be fatal.
    writeConfigFile({ version: 1, instances: { default: instance() } }, file);
    const report = await run({
      "auth.test": { ok: true, team_id: "T1" },
      "apps.connections.open": { ok: true, url: "wss://x" },
    });
    const herdr = report.checks.find((c) => c.name === "herdr socket");
    expect(herdr?.state).toBe("fail");
    expect(report.checks.some((c) => c.name === "service" && c.state === "warn")).toBe(true);
  });

  it("reports every problem, not just the first", async () => {
    writeConfigFile(
      {
        version: 1,
        instances: {
          default: { ...instance(), allowedUsers: [], slack: { ...instance().slack, teamId: "" } },
        },
      },
      file,
    );
    const report = await run({ "auth.test": { ok: true, team_id: "T1" } });
    expect(report.checks.filter((c) => c.state === "fail").length).toBeGreaterThan(1);
  });

  describe("background network", () => {
    it("is skipped when no service is installed", async () => {
      writeConfigFile({ version: 1, instances: { default: instance() } }, file);
      const report = await runDoctor({
        instance: "default",
        configFile: file,
        fetchImpl: stubFetch({ "auth.test": { ok: true, team_id: "T1", user_id: "U1" } }),
        home: dir,
      });
      const check = report.checks.find((c) => c.name === "background network");
      expect(check).toMatchObject({ state: "pass", detail: expect.stringContaining("skipped") });
    });

    it("passes when the service is installed and reaches Slack with no override", async () => {
      writeConfigFile({ version: 1, instances: { default: instance() } }, file);
      const { installService } = await import("../../src/daemon/service.js");
      installService("default", "/app/cli.js", here, "/usr/bin/node", {}, dir);
      const report = await runDoctor({
        instance: "default",
        configFile: file,
        fetchImpl: stubFetch({ "auth.test": { ok: true, team_id: "T1", user_id: "U1" } }),
        home: dir,
        networkProbe: () => true,
      });
      const check = report.checks.find((c) => c.name === "background network");
      expect(check).toMatchObject({ state: "pass" });
      expect(check?.detail).toContain("no override needed");
    });

    it("fails when the service is installed and nothing reaches Slack", async () => {
      // This is exactly the shape of the real bug: passes everywhere else
      // (this check runs from an interactive shell that has what it needs),
      // fails only in the background context the service actually runs in.
      writeConfigFile({ version: 1, instances: { default: instance() } }, file);
      const { installService } = await import("../../src/daemon/service.js");
      installService("default", "/app/cli.js", here, "/usr/bin/node", {}, dir);
      const report = await runDoctor({
        instance: "default",
        configFile: file,
        fetchImpl: stubFetch({ "auth.test": { ok: true, team_id: "T1", user_id: "U1" } }),
        home: dir,
        networkProbe: () => false,
      });
      const check = report.checks.find((c) => c.name === "background network");
      expect(check).toMatchObject({ state: "fail" });
      expect(check?.fix).toContain("reconfigure");
      expect(report.ok).toBe(false);
    });

    it("passes using a saved override that still works", async () => {
      writeConfigFile({ version: 1, instances: { default: instance() } }, file);
      const { installService } = await import("../../src/daemon/service.js");
      const { saveNetworkEnv } = await import("../../src/config/network-env.js");
      installService("default", "/app/cli.js", here, "/usr/bin/node", {}, dir);
      saveNetworkEnv("default", { NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" });

      const report = await runDoctor({
        instance: "default",
        configFile: file,
        fetchImpl: stubFetch({ "auth.test": { ok: true, team_id: "T1", user_id: "U1" } }),
        home: dir,
        // Bare env fails (simulating launchd); adding the saved override fixes it.
        networkProbe: (env) => Boolean(env.NODE_EXTRA_CA_CERTS),
      });
      const check = report.checks.find((c) => c.name === "background network");
      expect(check).toMatchObject({ state: "pass" });
      expect(check?.detail).toContain("NODE_EXTRA_CA_CERTS");
    });

    it("is skipped entirely offline", async () => {
      writeConfigFile({ version: 1, instances: { default: instance() } }, file);
      const { installService } = await import("../../src/daemon/service.js");
      installService("default", "/app/cli.js", here, "/usr/bin/node", {}, dir);
      const report = await runDoctor({
        instance: "default",
        configFile: file,
        offline: true,
        home: dir,
      });
      const check = report.checks.find((c) => c.name === "background network");
      expect(check).toMatchObject({ state: "warn", detail: expect.stringContaining("offline") });
    });
  });

  it("renders a numbered fix list", async () => {
    writeConfigFile({ version: 1, instances: { default: instance() } }, file);
    const text = formatReport(await run({ "auth.test": { ok: true, team_id: "T1" } }));
    expect(text).toContain("To fix:");
    expect(text).toMatch(/\d+\. /);
  });
});
