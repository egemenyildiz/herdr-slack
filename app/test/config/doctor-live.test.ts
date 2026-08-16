import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultInstance, writeConfigFile } from "../../src/config/config.js";
import { runDoctor } from "../../src/config/doctor.js";
import { snapshot } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";

function stubFetch(responses: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const method = String(url).split("/api/")[1] ?? "";
    return {
      json: async () => responses[method] ?? { ok: false, error: "x" },
      status: 200,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("doctor against a live herdr socket", () => {
  let dir: string;
  let file: string;
  let fake: FakeHerdr;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-doctor-live-"));
    file = path.join(dir, "config.json");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
    fake = await FakeHerdr.start();
  });

  afterEach(async () => {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  });

  const write = () =>
    writeConfigFile(
      {
        version: 1,
        instances: {
          default: defaultInstance({
            herdrSocketPath: fake.socketPath,
            slack: {
              botToken: "xoxb-1",
              appToken: "xapp-1",
              teamId: "T1",
              appId: "A1",
              botUserId: "U1",
            },
            allowedUsers: ["U1"],
          }),
        },
      },
      file,
    );

  const happySlack = {
    "auth.test": { ok: true, team: "Acme", team_id: "T1", user_id: "U1" },
    "apps.connections.open": { ok: true, url: "wss://x" },
  };

  it("passes every check when herdr and Slack are both healthy", async () => {
    write();
    fake.on("session.snapshot", () => ({ snapshot: snapshot() }));

    const report = await runDoctor({
      instance: "default",
      configFile: file,
      fetchImpl: stubFetch(happySlack),
      home: dir,
    });

    expect(report.checks.find((c) => c.name === "herdr")?.state).toBe("pass");
    expect(report.checks.find((c) => c.name === "herdr protocol")?.state).toBe("pass");
    expect(report.checks.find((c) => c.name === "slack bot token")?.state).toBe("pass");
    expect(report.checks.find((c) => c.name === "slack app token")?.state).toBe("pass");
    // Service is only a warning: nothing is broken, it just will not survive a reboot.
    expect(report.ok).toBe(true);
  });

  it("fails a herdr speaking an older protocol, and names the fix", async () => {
    write();
    fake.on("session.snapshot", () => ({ snapshot: { ...snapshot(), protocol: 18 } }));

    const report = await runDoctor({
      instance: "default",
      configFile: file,
      fetchImpl: stubFetch(happySlack),
      home: dir,
    });

    const check = report.checks.find((c) => c.name === "herdr protocol");
    expect(check?.state).toBe("fail");
    expect(check?.fix).toBe("herdr update");
    expect(report.ok).toBe(false);
  });

  it("warns rather than failing when a snapshot cannot be read", async () => {
    write();
    // No session.snapshot handler → herdr answers unknown_method.
    const report = await runDoctor({
      instance: "default",
      configFile: file,
      fetchImpl: stubFetch(happySlack),
      home: dir,
    });
    expect(report.checks.find((c) => c.name === "herdr protocol")?.state).toBe("warn");
  });

  it("skips network checks when asked to run offline", async () => {
    write();
    fake.on("session.snapshot", () => ({ snapshot: snapshot() }));
    const report = await runDoctor({
      instance: "default",
      configFile: file,
      offline: true,
      home: dir,
    });
    expect(report.checks.find((c) => c.name === "slack")?.state).toBe("warn");
  });
});
