import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installService,
  parseLaunchctlPid,
  renderLaunchd,
  renderShim,
  renderSystemd,
  serviceLabel,
  serviceStatus,
  shimPath,
  uninstallService,
  unitPath,
} from "../../src/daemon/service.js";

describe("service units", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-service-"));
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("names units per instance so two can coexist", () => {
    expect(serviceLabel("default")).toBe("dev.herdr.slack.default");
    expect(unitPath("sess-work", "darwin", dir)).toContain("dev.herdr.slack.sess-work.plist");
    expect(unitPath("sess-work", "linux", dir)).toContain("herdr-slack@sess-work.service");
  });

  it("does not restart systemd services after a clean exit", () => {
    // Restart=always would defeat `daemon stop`, which launchd honours via
    // SuccessfulExit=false. The platforms must behave the same.
    const unit = renderSystemd("default", "/tmp/shim");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("Restart=always");
  });

  it("tells launchd not to restart a clean exit either", () => {
    const plist = renderLaunchd("default", "/tmp/shim");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
  });

  it("points the unit at a shim in the config dir, never at the plugin root", () => {
    // HERDR_PLUGIN_ROOT is a herdr-managed checkout that can be replaced on
    // upgrade, which would silently break the service.
    const result = installService("default", "/somewhere/app/dist/cli.js", "linux");
    expect(result.shim).toContain(path.join(dir, "config"));
    expect(readFileSync(result.unit, "utf8")).toContain(result.shim);
  });

  it("makes the shim executable and private", () => {
    const result = installService("default", "/somewhere/app/dist/cli.js", "linux");
    expect(statSync(result.shim).mode & 0o777).toBe(0o700);
  });

  it("passes the instance explicitly to the daemon", () => {
    // The daemon must never infer its instance from the environment — under
    // launchd there is no herdr environment at all.
    const shim = renderShim("/usr/bin/node", "/app/cli.js", "sess-work");
    expect(shim).toContain('daemon run --instance "sess-work"');
  });

  it("bakes config and state dirs into the shim for launchd/systemd", () => {
    // Without these, launchd's near-empty environment leaves the daemon with
    // no HERDR_PLUGIN_CONFIG_DIR/STATE_DIR at all (ADR 0002).
    const shim = renderShim("/usr/bin/node", "/app/cli.js", "default");
    expect(shim).toContain(`HERDR_PLUGIN_CONFIG_DIR=${JSON.stringify(path.join(dir, "config"))}`);
    expect(shim).toContain(`HERDR_PLUGIN_STATE_DIR=${JSON.stringify(path.join(dir, "state"))}`);
  });

  it("tells Linux users about linger, which the service needs to survive logout", () => {
    const result = installService("default", "/app/cli.js", "linux");
    expect(result.followUp.join(" ")).toContain("enable-linger");
  });

  it("reports a unit that was never installed", () => {
    const status = serviceStatus("nope", "linux");
    expect(status).toMatchObject({ installed: false, loaded: false, targetOk: false });
  });

  it("flags a unit whose target has gone missing", () => {
    // The exact failure a plugin upgrade causes: unit still enabled, entrypoint
    // moved, daemon silently never starts again.
    installService("default", path.join(dir, "gone", "cli.js"), "linux");
    const status = serviceStatus("default", "linux");
    expect(status.installed).toBe(true);
    expect(status.targetOk).toBe(false);
  });

  it("accepts a unit whose target exists", () => {
    const entry = path.join(dir, "cli.js");
    rmSync(entry, { force: true });
    writeFileSync(entry, "");
    installService("default", entry, "linux");
    expect(serviceStatus("default", "linux").targetOk).toBe(true);
  });

  it("removes both unit and shim on uninstall", () => {
    const result = installService("default", "/app/cli.js", "linux");
    uninstallService("default", "linux");
    expect(existsSync(result.unit)).toBe(false);
    expect(existsSync(shimPath("default"))).toBe(false);
  });
});

describe("parseLaunchctlPid", () => {
  it("reads the pid while the job is running", () => {
    const output = `
	state = running
	pid = 12165
		state = active
`;
    expect(parseLaunchctlPid(output)).toBe(12165);
  });

  it("is undefined when the job is loaded but not running", () => {
    const output = `
	state = not running
	stdout path = /Users/ege/.local/state/herdr/plugins/herdr-slack/default/daemon.log
`;
    expect(parseLaunchctlPid(output)).toBeUndefined();
  });
});
