import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfigFile } from "../../src/config/config.js";
import { FileSecretStore, MemorySecretStore } from "../../src/config/secrets.js";
import { readSetupStatus } from "../../src/config/setup-status.js";
import { type SetupIo, runSetup } from "../../src/config/setup.js";

/**
 * The end-of-setup doctor run is stubbed everywhere by default: the real one
 * spawns an HTTPS probe subprocess and reads this machine's actual installed
 * service, which makes these tests slow and dependent on the developer's own
 * install. doctor has its own suite; one test below covers the wiring.
 */
const noopDoctor = async () => ({ instance: "default", ok: true, checks: [] });

/** The allowlist step is the only free-text question the tests answer. */
const isAllowlist = (question: string) => question.includes("Member ID");

/** A scripted operator: answers queued, clipboard tokens queued. */
function fakeIo(overrides: Partial<SetupIo> & { tokens?: (string | null)[] } = {}) {
  const printed: string[] = [];
  const opened: string[] = [];
  const tokens = overrides.tokens ?? ["xapp-good", "xoxb-good"];
  let tokenIndex = 0;

  const io: SetupIo = {
    print: (text) => printed.push(text),
    ask: async (_q, fallback = "") => fallback,
    confirm: async (_q, fallbackYes) => fallbackYes,
    openBrowser: async (url) => {
      opened.push(url);
    },
    copyToClipboard: async () => true,
    askSecret: async () => tokens[tokenIndex++] ?? "",
    ...overrides,
  };
  return { io, printed, opened, text: () => printed.join("") };
}

function stubFetch(responses: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const method = String(url).split("/api/")[1] ?? "";
    return {
      json: async () => responses[method] ?? { ok: false, error: "unknown" },
      status: 200,
    } as Response;
  }) as unknown as typeof fetch;
}

const happy = {
  "auth.test": { ok: true, team: "Acme", team_id: "T1", user_id: "UBOT", bot_id: "B1" },
  "bots.info": { ok: true, bot: { app_id: "A1" } },
  "apps.connections.open": { ok: true, url: "wss://x" },
};

describe("runSetup", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-setup-"));
    file = path.join(dir, "config.json");
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "cfg");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  const run = (io: SetupIo, responses = happy, extra = {}) =>
    runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      fetchImpl: stubFetch(responses),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: new FileSecretStore(),
      runDoctorFn: noopDoctor,
      ...extra,
    });

  it("completes and writes a usable config", async () => {
    const { io } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    const outcome = await run(io);

    expect(outcome.status).toBe("complete");
    const config = readConfigFile(file);
    const instance = config.instances.default;
    expect(instance?.slack.teamId).toBe("T1");
    expect(instance?.slack.appId).toBe("A1");
    expect(instance?.allowedUsers).toEqual(["U0123456"]);
    expect(readSetupStatus("default")).toBeNull();
  });

  it("accepts a pasted member id on the allowlist step", async () => {
    const { io, text } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    await run(io);
    expect(text()).toContain("✓ U0123456");
    expect(readConfigFile(file).instances.default?.allowedUsers).toEqual(["U0123456"]);
  });

  it("shows the data-exposure notice before writing any credential", async () => {
    const { io, text } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    await run(io);
    expect(text()).toContain("Default: terminal output goes to Slack");
  });

  it("defaults to full so session cards show responses, with a clear warning", async () => {
    const { io, text } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    await run(io);
    expect(readConfigFile(file).instances.default?.contentMode).toBe("full");
    expect(text()).toContain("Default: terminal output goes to Slack");
    expect(text()).toContain("retained there");
  });

  it("honours an explicit opt-in to full", async () => {
    const { io, text } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
      confirm: async (q, fb) => (q.includes("terminal output") ? true : fb),
    });
    await run(io);
    expect(readConfigFile(file).instances.default?.contentMode).toBe("full");
    expect(text()).toContain("retained");
  });

  it("honours an explicit opt-out to summary", async () => {
    const { io, text } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
      confirm: async (q, fb) => (q.includes("terminal output") ? false : fb),
    });
    await run(io);
    expect(readConfigFile(file).instances.default?.contentMode).toBe("summary");
    expect(text()).toContain("Every control still works");
  });

  it("prints an admin request when no bot token is pasted", async () => {
    // The restricted-workspace path: a wizard cannot grant permission, but it
    // can make asking for it a copy-paste. Install-to-workspace is the step an
    // admin gates, so the app-level token arrives and the bot token does not.
    const { io, text } = fakeIo({ tokens: ["xapp-good", ""] });
    const outcome = await run(io);

    expect(outcome.status).toBe("needs_admin");
    expect(text()).toContain("Socket Mode");
    expect(text()).toContain("no public URL");
    expect(outcome.message).toContain("--resume");
    expect(readSetupStatus("default")?.status).toBe("needs_admin");
  });

  it("stops cleanly when the app-level token never arrives", async () => {
    const { io } = fakeIo({
      tokens: [""],
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    const outcome = await run(io);
    expect(outcome.status).toBe("needs_admin");
  });

  it("refuses a bot token Slack rejects", async () => {
    const { io } = fakeIo();
    const outcome = await run(io, { ...happy, "auth.test": { ok: false, error: "invalid_auth" } });
    expect(outcome.status).toBe("abandoned");
    expect(outcome.message).toContain("rejected");
  });

  it("refuses an app token that cannot open a socket", async () => {
    const { io } = fakeIo();
    const outcome = await run(io, {
      ...happy,
      "apps.connections.open": { ok: false, error: "invalid_auth" },
    });
    expect(outcome.status).toBe("abandoned");
    expect(outcome.message).toContain("Socket Mode");
  });

  it("refuses to finish without an allowlist", async () => {
    // Not a warning — an empty allowlist is a shell for anyone who can DM.
    const { io } = fakeIo({ ask: async () => "" });
    const outcome = await run(io);
    expect(outcome.status).toBe("abandoned");
    expect(outcome.message).toContain("allowlist");
  });

  it("rejects handles and re-asks for a member id", async () => {
    let asked = 0;
    const { io, text } = fakeIo({
      ask: async (q) => (isAllowlist(q) ? (asked++ === 0 ? "@ege" : "U0123456") : ""),
    });
    const outcome = await run(io);
    expect(outcome.status).toBe("complete");
    expect(text()).toContain("Not a member ID");
    expect(readConfigFile(file).instances.default?.allowedUsers).toEqual(["U0123456"]);
  });

  it("accepts several member ids at once", async () => {
    const { io } = fakeIo({ ask: async (q) => (isAllowlist(q) ? "U0123456, U0987654" : "") });
    await run(io);
    expect(readConfigFile(file).instances.default?.allowedUsers).toEqual(["U0123456", "U0987654"]);
  });

  it("says where to find a member id", async () => {
    const { io, text } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    await run(io);
    expect(text()).toContain("Copy member ID");
    expect(text()).toContain("cannot tell us which human");
  });

  it("derives the instance from the socket it was pointed at", async () => {
    const { io } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    const outcome = await run(io, happy, {
      socketPath: "/home/x/.config/herdr/sessions/work/herdr.sock",
    });
    expect(outcome.instance).toBe("sess-work");
    expect(readConfigFile(file).instances["sess-work"]).toBeDefined();
  });

  it("opens the create-app page for the user", async () => {
    const asked: string[] = [];
    const { io, opened, text } = fakeIo({
      ask: async (q, fb = "") => {
        asked.push(q);
        return isAllowlist(q) ? "U0123456" : fb;
      },
    });
    await run(io);
    expect(opened[0]).toContain("api.slack.com/apps/new");
    expect(text()).toContain("App manifest copied to your clipboard");
    expect(text()).toContain("From an app manifest");
    expect(asked.some((q) => q.includes("Press Enter when the app is created"))).toBe(true);
  });

  it("installs the service when asked", async () => {
    const calls: string[] = [];
    const { io } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    await run(io, happy, {
      noService: false,
      installServiceFn: (instance: string) => {
        calls.push(instance);
        return { unit: "/tmp/u", shim: "/tmp/s", followUp: ["systemctl --user daemon-reload"] };
      },
      discoverNetworkEnvFn: () => ({ kind: "ok" }),
    });
    expect(calls).toEqual(["default"]);
  });

  it("runs the checks before handing back, in the same pane", async () => {
    // The popup closes when setup exits, so "run doctor next" meant finding a
    // terminal and knowing the plugin's absolute path. The one moment someone
    // is definitely still watching is right now.
    let sawInstance = "";
    const { io, text } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    await run(io, happy, {
      runDoctorFn: async (opts: { instance: string }) => {
        sawInstance = opts.instance;
        return {
          instance: opts.instance,
          ok: true,
          checks: [{ name: "daemon", state: "pass" as const, detail: "running (pid 1)" }],
        };
      },
    });

    expect(sawInstance).toBe("default");
    expect(text()).toContain("daemon");
    expect(text()).toContain("running (pid 1)");
  });

  it("finishes setup even when the checks themselves blow up", async () => {
    // Everything durable is already written by this point; a broken diagnostic
    // is not a reason to throw the install away.
    const { io, text } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    const outcome = await run(io, happy, {
      runDoctorFn: async () => {
        throw new Error("doctor exploded");
      },
    });

    expect(outcome.status).toBe("complete");
    expect(text()).toContain("doctor exploded");
  });

  it("starts the service rather than printing the command and stopping", async () => {
    // Setup used to install a unit and tell the user to load it themselves, so
    // "Setup complete" left nothing running and doctor immediately said
    // "installed but not loaded". The daemon is the app.
    const enabled: string[] = [];
    const { io, text } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    await run(io, happy, {
      noService: false,
      installServiceFn: () => ({ unit: "/tmp/u", shim: "/tmp/s", followUp: [] }),
      discoverNetworkEnvFn: () => ({ kind: "ok" }),
      enableServiceFn: (instance: string) => {
        enabled.push(instance);
        return { ok: true, detail: "loaded dev.herdr.slack.default", followUp: [] };
      },
    });

    expect(enabled).toEqual(["default"]);
    expect(text()).toContain("Service started");
  });

  it("says what to run by hand when it cannot start the service itself", async () => {
    const { io, text } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    const outcome = await run(io, happy, {
      noService: false,
      installServiceFn: () => ({ unit: "/tmp/u", shim: "/tmp/s", followUp: [] }),
      discoverNetworkEnvFn: () => ({ kind: "ok" }),
      enableServiceFn: () => ({
        ok: false,
        detail: "launchctl: permission denied",
        followUp: ["launchctl bootstrap gui/$(id -u) /tmp/u"],
      }),
    });

    // Still a completed setup: the credentials and config are written.
    expect(outcome.status).toBe("complete");
    expect(text()).toContain("could not start it automatically");
    expect(text()).toContain("launchctl bootstrap");
  });

  it("bakes a discovered TLS override into the service and tells the user", async () => {
    // This is the actual bug fixed by ADR 0009: a machine that needs
    // NODE_EXTRA_CA_CERTS in the shell works fine here, in setup, and then
    // fails once installed as a service unless this override is baked in.
    const installed: unknown[] = [];
    const { io, text } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    await run(io, happy, {
      noService: false,
      installServiceFn: (...args: unknown[]) => {
        installed.push(args);
        return { unit: "/tmp/u", shim: "/tmp/s", followUp: [] };
      },
      discoverNetworkEnvFn: () => ({
        kind: "fixed",
        env: { NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" },
      }),
    });
    expect(text()).toContain("NODE_EXTRA_CA_CERTS");
    expect(installed[0]).toEqual([
      "default",
      "/app/cli.js",
      undefined,
      undefined,
      { NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" },
    ]);
  });

  it("warns plainly when nothing lets the service reach Slack", async () => {
    const { io, text } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    const outcome = await run(io, happy, {
      noService: false,
      installServiceFn: () => ({ unit: "/tmp/u", shim: "/tmp/s", followUp: [] }),
      discoverNetworkEnvFn: () => ({ kind: "unreachable" }),
    });
    // A machine that cannot reach Slack in the background still gets a
    // usable install for running the daemon by hand — this is a warning, not
    // a reason to abandon setup.
    expect(outcome.status).toBe("complete");
    expect(text()).toContain("Could not find a way for the background service to reach Slack");
  });
});

describe("token collection fallback", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-setup-fb-"));
    file = path.join(dir, "config.json");
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "cfg");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("re-prompts once when a pasted token has the wrong shape", async () => {
    // The usual mistake is grabbing the wrong field off the settings page; a
    // shape check says so immediately instead of spending a Slack call on it.
    const asked: string[] = [];
    const { io } = fakeIo({
      tokens: ["not-a-token", "xapp-typed", "xoxb-typed"],
      ask: async (q, fb = "") => {
        asked.push(q);
        return isAllowlist(q) ? "U0123456" : fb;
      },
    });

    const outcome = await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      fetchImpl: stubFetch(happy),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: new FileSecretStore(),
      runDoctorFn: noopDoctor,
    });

    expect(outcome.status).toBe("complete");
    expect(readConfigFile(file).instances.default?.slack.botToken).toBe("xoxb-typed");
  });

  it("keeps a token pasted out of order instead of refusing it", async () => {
    // The wizard asks app-level first, but someone who already installed the
    // app may have the bot token to hand. Refusing it would mean going back
    // for it a second time.
    const { io, text } = fakeIo({
      tokens: ["xoxb-early", "xapp-good"],
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });

    const outcome = await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      fetchImpl: stubFetch(happy),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: new FileSecretStore(),
      runDoctorFn: noopDoctor,
    });

    expect(outcome.status).toBe("complete");
    const slack = readConfigFile(file).instances.default?.slack;
    expect(slack?.appToken).toBe("xapp-good");
    // Never asked for it a second time.
    expect(slack?.botToken).toBe("xoxb-early");
    expect(text()).toContain("kept it for later");
  });

  it("does not ask for a token it already holds", async () => {
    const asked: string[] = [];
    const { io, text } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
      askSecret: async (q) => {
        asked.push(q);
        // Bot token at the app-level prompt: kept, so its own step is skipped.
        return asked.length === 1 ? "xoxb-early" : "xapp-good";
      },
    });

    await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      fetchImpl: stubFetch(happy),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: new FileSecretStore(),
      runDoctorFn: noopDoctor,
    });

    expect(asked).toHaveLength(2);
    expect(readConfigFile(file).instances.default?.slack.botToken).toBe("xoxb-early");
    expect(text()).toContain("Already have the Bot User OAuth Token");
  });

  it("warns that Slack lands you on the wrong page first", async () => {
    const { io, text } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      fetchImpl: stubFetch(happy),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: new FileSecretStore(),
      runDoctorFn: noopDoctor,
    });
    expect(text()).toContain("Basic Information");
    expect(text()).toContain("Install App");
    expect(text()).not.toContain("OAuth & Permissions");
  });

  it("numbers its steps so a long scroll reads as a sequence", async () => {
    const { io, text } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      fetchImpl: stubFetch(happy),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: new FileSecretStore(),
      runDoctorFn: noopDoctor,
    });
    for (const n of [1, 2, 3, 5, 6]) expect(text()).toContain(`Step ${n}/6`);
  });

  it("stops for admin approval when nothing is pasted", async () => {
    const { io } = fakeIo({ tokens: [""], ask: async () => "" });
    const outcome = await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      fetchImpl: stubFetch(happy),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: new FileSecretStore(),
      runDoctorFn: noopDoctor,
    });
    expect(outcome.status).toBe("needs_admin");
  });
});

describe("setup modes", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-mode-"));
    file = path.join(dir, "config.json");
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "cfg");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  const run = (
    io: SetupIo,
    mode: "fresh" | "resume" | "reconfigure",
    store = new FileSecretStore(),
  ) =>
    runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      fetchImpl: stubFetch(happy),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: store,
      mode,
      runDoctorFn: noopDoctor,
    });

  const seed = async () => {
    const { io } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    await run(io, "fresh");
  };

  it("resumes without a config, because that is the case it exists for", async () => {
    // Admin approval blocks the install before anything is written, and the
    // admin-request message tells people to re-run with --resume. Requiring a
    // config here would make the documented recovery path a dead end.
    const { io, opened } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    const outcome = await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      mode: "resume",
      fetchImpl: stubFetch(happy),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: new FileSecretStore(),
      runDoctorFn: noopDoctor,
    });

    expect(outcome.status).toBe("complete");
    // Skipped app creation: the app already exists.
    expect(opened.join()).not.toContain("apps/new");
  });

  it("refuses to reconfigure when there is nothing to reconfigure", async () => {
    const { io } = fakeIo();
    const outcome = await run(io, "reconfigure");
    expect(outcome.status).toBe("abandoned");
    expect(outcome.message).toContain("No existing configuration");
  });

  it("skips app creation when resuming", async () => {
    // The app already exists — walking the user through creating another is
    // exactly the wrong advice after an admin approval.
    await seed();
    const { io, opened } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    const outcome = await run(io, "resume");

    expect(outcome.status).toBe("complete");
    expect(opened.some((url) => url.includes("apps/new"))).toBe(false);
  });

  it("hands over the new manifest when reconfiguring an existing app", async () => {
    // There is no API to push a manifest without a configuration token, and a
    // new scope (assistant:write) is not granted to an already-installed app —
    // so the reinstall instruction is the part that actually applies it.
    await seed();
    const { io, text } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    await run(io, "reconfigure");

    expect(text()).toContain("App Manifest");
    expect(text()).toContain("Reinstall to Workspace");
  });

  it("reuses stored credentials when reconfiguring", async () => {
    const store = new MemorySecretStore();
    const { io: first } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    await run(first, "fresh", store);

    // No tokens offered this time; it must not ask for any.
    const { io, text } = fakeIo({
      tokens: [],
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    const outcome = await run(io, "reconfigure", store);

    expect(outcome.status).toBe("complete");
    expect(text()).toContain("Reusing the credentials");
  });

  it("falls back to asking when the stored credentials no longer work", async () => {
    // A revoked token written straight back would only surface later as a
    // confusing runtime failure.
    const store = new MemorySecretStore();
    const { io: first } = fakeIo({
      ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb),
    });
    await run(first, "fresh", store);

    const { io } = fakeIo({ ask: async (q, fb = "") => (isAllowlist(q) ? "U0123456" : fb) });
    const outcome = await runSetup({
      socketPath: "/tmp/herdr.sock",
      configFile: file,
      io,
      fetchImpl: stubFetch({ ...happy, "auth.test": { ok: false, error: "token_revoked" } }),
      entrypoint: "/app/cli.js",
      noService: true,
      secretStore: store,
      mode: "reconfigure",
    });

    expect(outcome.status).toBe("abandoned");
  });

  it("keeps the existing label as the default", async () => {
    await seed();
    const asked: string[] = [];
    const { io } = fakeIo({
      ask: async (q, fb = "") => {
        asked.push(`${q}|${fb}`);
        return isAllowlist(q) ? "U0123456" : fb;
      },
    });
    await run(io, "resume");
    expect(asked.some((entry) => entry.startsWith("Profile label|personal"))).toBe(true);
  });
});
