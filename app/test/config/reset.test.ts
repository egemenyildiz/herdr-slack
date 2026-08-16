import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import { stateDir } from "../../src/config/instance.js";
import { runReset } from "../../src/config/reset.js";
import { MemorySecretStore } from "../../src/config/secrets.js";

describe("runReset", () => {
  let dir: string;
  let file: string;

  const writeConfig = (instances: Record<string, unknown>) =>
    writeFileSync(file, `${JSON.stringify({ version: 1, instances }, null, 2)}\n`, { mode: 0o600 });
  const noService = () => ({ ok: false, detail: "not loaded" });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-reset-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    file = path.join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("removes the config, the state, and the credentials", async () => {
    writeConfig({ default: defaultInstance() });
    mkdirSync(stateDir("default"), { recursive: true });
    writeFileSync(path.join(stateDir("default"), "sessions.json"), "{}");

    const store = new MemorySecretStore();
    await store.set("default", "botToken", "xoxb-EXAMPLE");

    const result = await runReset({
      instance: "default",
      configFile: file,
      secretStore: store,
      uninstallServiceFn: () => undefined,
      disableServiceFn: noService,
      home: dir,
    });

    expect(existsSync(file)).toBe(false);
    expect(existsSync(stateDir("default"))).toBe(false);
    expect(await store.get("default", "botToken")).toBeNull();
    expect(result.removed.join()).toContain("keychain");
  });

  it("leaves other instances alone", async () => {
    // Work and personal share one config file; resetting one must not sign the
    // other out.
    writeConfig({ default: defaultInstance(), "sess-work": defaultInstance({ label: "work" }) });

    await runReset({
      instance: "default",
      configFile: file,
      secretStore: new MemorySecretStore(),
      uninstallServiceFn: () => undefined,
      disableServiceFn: noService,
      home: dir,
    });

    const rest = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(rest.instances)).toEqual(["sess-work"]);
  });

  it("unregisters the service, not just its file", async () => {
    // Deleting the plist leaves launchd holding the job definition, pointing at
    // a shim that no longer exists — one non-zero exit from being run again.
    const disabled: string[] = [];
    const result = await runReset({
      instance: "default",
      configFile: file,
      secretStore: new MemorySecretStore(),
      uninstallServiceFn: () => undefined,
      disableServiceFn: (instance: string) => {
        disabled.push(instance);
        return { ok: true, detail: "booted out dev.herdr.slack.default" };
      },
      home: dir,
    });

    expect(disabled).toEqual(["default"]);
    expect(result.removed.join()).toContain("booted out");
  });

  it("does not claim to have unregistered a service that was never loaded", async () => {
    const result = await runReset({
      instance: "default",
      configFile: file,
      secretStore: new MemorySecretStore(),
      uninstallServiceFn: () => undefined,
      disableServiceFn: () => ({ ok: false, detail: "no such process" }),
      home: dir,
    });
    expect(result.removed.join()).not.toContain("service:");
  });

  it("says what it did not remove", async () => {
    const result = await runReset({
      instance: "default",
      configFile: file,
      secretStore: new MemorySecretStore(),
      uninstallServiceFn: () => undefined,
      disableServiceFn: noService,
      home: dir,
    });
    expect(result.kept.join()).toContain("Slack app");
  });

  it("is safe to run when there is nothing to remove", async () => {
    const result = await runReset({
      instance: "default",
      configFile: file,
      secretStore: new MemorySecretStore(),
      uninstallServiceFn: () => undefined,
      disableServiceFn: noService,
      home: dir,
    });
    expect(result.removed).toEqual([]);
  });

  it("does not claim to have removed a credential that was never stored", async () => {
    const store = new MemorySecretStore();
    await store.set("default", "botToken", "xoxb-EXAMPLE");

    const result = await runReset({
      instance: "default",
      configFile: file,
      secretStore: store,
      uninstallServiceFn: () => undefined,
      disableServiceFn: noService,
      home: dir,
    });

    expect(result.removed.filter((line) => line.includes("keychain"))).toHaveLength(1);
  });
});
