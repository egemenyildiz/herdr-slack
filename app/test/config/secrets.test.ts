import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultInstance, withCredentials, writeConfigFile } from "../../src/config/config.js";
import { FileSecretStore, MemorySecretStore } from "../../src/config/secrets.js";
import { type SetupIo, runSetup } from "../../src/config/setup.js";

describe("MemorySecretStore contract", () => {
  it("round-trips a credential per instance and field", async () => {
    const store = new MemorySecretStore();
    await store.set("default", "botToken", "xoxb-a");
    await store.set("sess-work", "botToken", "xoxb-b");

    expect(await store.get("default", "botToken")).toBe("xoxb-a");
    expect(await store.get("sess-work", "botToken")).toBe("xoxb-b");
    expect(await store.get("default", "appToken")).toBeNull();
  });

  it("removes a credential", async () => {
    const store = new MemorySecretStore();
    await store.set("default", "appToken", "xapp-a");
    await store.remove("default", "appToken");
    expect(await store.get("default", "appToken")).toBeNull();
  });
});

describe("withCredentials", () => {
  it("hydrates tokens from the keychain", async () => {
    const store = new MemorySecretStore();
    await store.set("default", "botToken", "xoxb-kc");
    await store.set("default", "appToken", "xapp-kc");

    const resolved = await withCredentials(
      "default",
      defaultInstance({ credentialStore: "keychain" }),
      store,
    );
    expect(resolved.slack.botToken).toBe("xoxb-kc");
    expect(resolved.slack.appToken).toBe("xapp-kc");
  });

  it("leaves a file-backed instance untouched", async () => {
    const instance = defaultInstance({
      credentialStore: "file",
      slack: { botToken: "xoxb-f", appToken: "xapp-f", teamId: "T", appId: "A", botUserId: "U" },
    });
    const resolved = await withCredentials("default", instance, new MemorySecretStore());
    expect(resolved.slack.botToken).toBe("xoxb-f");
  });

  it("lets an env override win over the keychain", async () => {
    // resolveInstance applies env first; the keychain must not clobber it, so a
    // secrets manager still takes precedence over both.
    const store = new MemorySecretStore();
    await store.set("default", "botToken", "xoxb-kc");
    const instance = defaultInstance({
      credentialStore: "keychain",
      slack: { botToken: "xoxb-env", appToken: "", teamId: "T", appId: "A", botUserId: "U" },
    });
    const resolved = await withCredentials("default", instance, store);
    expect(resolved.slack.botToken).toBe("xoxb-env");
  });

  it("yields empty tokens when the keychain has nothing, rather than throwing", async () => {
    const resolved = await withCredentials(
      "default",
      defaultInstance({ credentialStore: "keychain" }),
      new MemorySecretStore(),
    );
    expect(resolved.slack.botToken).toBe("");
  });
});

describe("setup credential storage", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-sec-"));
    file = path.join(dir, "config.json");
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "cfg");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  const io = (tokens: string[]): SetupIo => {
    let i = 0;
    return {
      print: () => undefined,
      ask: async (q, fb = "") => (q.includes("Member ID") ? "U0123456" : fb),
      confirm: async (_q, fb) => fb,
      openBrowser: async () => undefined,
      copyToClipboard: async () => true,
      askSecret: async () => tokens[i++] ?? "",
    };
  };

  const fetchImpl = (async (url: string | URL) => {
    const method = String(url).split("/api/")[1] ?? "";
    const responses: Record<string, unknown> = {
      "auth.test": { ok: true, team: "Acme", team_id: "T1", user_id: "UBOT", bot_id: "B1" },
      "bots.info": { ok: true, bot: { app_id: "A1" } },
      "apps.connections.open": { ok: true, url: "wss://x" },
    };
    return { json: async () => responses[method], status: 200 } as Response;
  }) as unknown as typeof fetch;

  it("keeps tokens out of config.json when a keychain is available", async () => {
    const store = new MemorySecretStore();
    await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io: io(["xoxb-secret", "xapp-secret"]),
      fetchImpl,
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: store,
    });

    const raw = readFileSync(file, "utf8");
    // The whole point: reading the config file must not reveal a credential.
    expect(raw).not.toContain("xoxb-secret");
    expect(raw).not.toContain("xapp-secret");
    expect(await store.get("default", "botToken")).toBe("xoxb-secret");
    expect(await store.get("default", "appToken")).toBe("xapp-secret");
    expect(JSON.parse(raw).instances.default.credentialStore).toBe("keychain");
  }, 20_000);

  it("falls back to the 0600 file when there is no keychain", async () => {
    await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io: io(["xoxb-secret", "xapp-secret"]),
      fetchImpl,
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: new FileSecretStore(),
    });

    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.instances.default.credentialStore).toBe("file");
    expect(parsed.instances.default.slack.botToken).toBe("xoxb-secret");
  }, 20_000);

  it("writes the config 0600 either way", async () => {
    writeConfigFile({ version: 1, instances: {} }, file);
    const { statSync } = await import("node:fs");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
