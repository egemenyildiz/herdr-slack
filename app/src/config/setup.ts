import { createInterface } from "node:readline/promises";
import { enableService, installService } from "../daemon/service.js";
import { defaultSocketPath } from "../herdr/client.js";
import { type SlackAuth, authTest, slackCall, verifyAppToken } from "../slack/api.js";
import {
  CREATE_APP_URL,
  ICON_URL,
  adminRequest,
  appSettingsUrl,
  renderManifest,
} from "../slack/manifest.js";
import { looksLikeToken, writeClipboard } from "./clipboard.js";
import {
  type ContentMode,
  type InstanceConfig,
  defaultInstance,
  readConfigFile,
  upsertInstance,
  withCredentials,
} from "./config.js";
import { formatReport, runDoctor } from "./doctor.js";
import { configPath, instanceKeyForSocket } from "./instance.js";
import { command, iconPath } from "./invocation.js";
import {
  type NetworkEnv,
  clearNetworkEnv,
  discoverNetworkEnv,
  saveNetworkEnv,
} from "./network-env.js";
import { type SecretStore, detectSecretStore } from "./secrets.js";
import { clearSetupStatus, writeSetupStatus } from "./setup-status.js";
import { bold, box, cyan, dim, ok, stepBanner, tip, warn, wizardBanner } from "./setup-style.js";

export interface SetupIo {
  print(text: string): void;
  ask(question: string, fallback?: string): Promise<string>;
  confirm(question: string, fallbackYes: boolean): Promise<boolean>;
  openBrowser(url: string): Promise<void>;
  copyToClipboard(text: string): Promise<boolean>;
  /** Prompt for a credential. Implementations should not echo it. */
  askSecret(question: string): Promise<string>;
}

/** Setup modes: fresh install, resume after admin approval, or reconfigure settings. */
export type SetupMode = "fresh" | "resume" | "reconfigure";

export interface SetupOptions {
  mode?: SetupMode;
  socketPath?: string;
  configFile?: string;
  io: SetupIo;
  fetchImpl?: typeof fetch;
  entrypoint: string;
  installServiceFn?: typeof installService;
  secretStore?: SecretStore;
  /** Skip the service install (--no-service). */
  noService?: boolean;
  /** Test-only: replaces the real HTTPS reachability probe. */
  discoverNetworkEnvFn?: typeof discoverNetworkEnv;
  /** Test-only: replaces the real launchctl/systemctl call. */
  enableServiceFn?: typeof enableService;
  /** Test-only: replaces the end-of-setup doctor run. */
  runDoctorFn?: typeof runDoctor;
}

export interface SetupOutcome {
  status: "complete" | "needs_admin" | "abandoned";
  instance: string;
  message: string;
}

/** Text shown before any credential is written. Deliberately unmissable. */
export const DATA_EXPOSURE_NOTICE = `
┌─ ⚠️  Default: terminal output goes to Slack ──────────────────────┐
│ Extracted agent responses on session cards are stored on Slack's  │
│ servers: retained, searchable, and on a corporate workspace       │
│ exportable by workspace admins.                                   │
│                                                                   │
│ Pointing work agents at an employer's Slack can put source code,  │
│ .env contents and stray API keys into an admin-readable store.    │
│                                                                   │
│ Default below is YES (full). Say no for "summary": every control  │
│ still works, but no free terminal text leaves this machine.       │
└───────────────────────────────────────────────────────────────────┘
`;

/** Guided setup; clipboard copies are required because Slack exposes no token mint APIs. */
const TOKEN_LABEL = { bot: "Bot User OAuth Token", app: "App-Level Token" } as const;

/** Accept bot or app tokens in either order. */
class TokenBag {
  #tokens: Partial<Record<"bot" | "app", string>> = {};

  get(kind: "bot" | "app"): string | undefined {
    return this.#tokens[kind];
  }

  /** Classify by prefix and keep it. Returns what it turned out to be. */
  take(value: string): "bot" | "app" | null {
    for (const kind of ["bot", "app"] as const) {
      if (looksLikeToken(value, kind)) {
        this.#tokens[kind] = value;
        return kind;
      }
    }
    return null;
  }
}

/** Ask for a token; accept the sibling token and keep it for the other step. */
async function collectToken(
  io: SetupIo,
  want: "bot" | "app",
  bag: TokenBag,
): Promise<string | null> {
  const held = bag.get(want);
  if (held) {
    io.print(`${ok(`Already have the ${TOKEN_LABEL[want]} from earlier`)}\n`);
    return held;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = (await io.askSecret(`Paste the ${TOKEN_LABEL[want]} (hidden)`)).trim();
    if (!value) return null;

    const kind = bag.take(value);
    if (kind === want) return value;
    if (kind) {
      io.print(
        `${warn(`That is the ${TOKEN_LABEL[kind]} — kept it for later.`)}\n` +
          `${tip(`Still need the ${TOKEN_LABEL[want]}.`)}\n`,
      );
      continue;
    }
    io.print(
      `${warn(`That does not look like a ${TOKEN_LABEL[want]}.`)}\n` +
        `${dim(`Expected it to start with "${want === "bot" ? "xoxb-" : "xapp-"}".`)}\n`,
    );
  }
  return null;
}

const STEPS = 6;

/** A visible break between steps, so a long scroll reads as a sequence. */
function step(io: SetupIo, n: number, title: string): void {
  io.print(stepBanner(n, STEPS, title));
}

interface Preferences {
  label: string;
  appName: string;
  wantService: boolean;
}

async function askPreferences(
  io: SetupIo,
  instance: string,
  noService?: boolean,
  currentLabel?: string,
): Promise<Preferences> {
  io.print(`${dim("A few choices first — defaults are fine for a first install.")}\n\n`);
  return {
    label: await io.ask(
      "Profile label",
      currentLabel || (instance === "default" ? "personal" : instance),
    ),
    appName: await io.ask("Slack app display name", "Herdr"),
    wantService: noService
      ? false
      : await io.confirm("Install a user service so the bridge survives reboots?", true),
  };
}

/** Copy the manifest, open Slack, and wait for app creation. */
async function createAppStep(io: SetupIo, prefs: Preferences): Promise<void> {
  const manifest = renderManifest({ appName: prefs.appName });
  const copied = await io.copyToClipboard(manifest);

  io.print("\n");
  io.print(
    box("Create your Slack app", [
      "We copied an app manifest to your clipboard.",
      "A browser tab is about to open — create the app there,",
      "then come back here and press Enter.",
    ]),
  );
  io.print("\n");

  if (copied) {
    io.print(`${ok("App manifest copied to your clipboard")}\n`);
  } else {
    io.print(`${warn("Could not reach a clipboard — paste this yourself:")}\n\n`);
    io.print(`${dim(manifest)}\n\n`);
  }

  io.print(`${tip(`Opening ${cyan(CREATE_APP_URL)}`)}\n\n`);
  io.print(`  ${bold("1.")} Choose ${bold('"From an app manifest"')}\n`);
  io.print(`  ${bold("2.")} Pick the workspace this instance is for\n`);
  io.print(`  ${bold("3.")} Paste (${bold("⌘V")} / Ctrl+V) → Next → Create\n\n`);
  io.print(`${dim("Optional — a manifest cannot set an icon, so if you want one:")}\n`);
  io.print(`${dim("  Basic Information → Display Information → App icon")}\n`);
  io.print(`${dim(`  ${iconPath()}`)}\n`);
  io.print(`${dim(`  or ${ICON_URL}`)}\n\n`);

  await io.openBrowser(CREATE_APP_URL);

  await io.ask("Press Enter when the app is created (Next → Create)", "");
  io.print(`${ok("Great — next we install it and grab two tokens")}\n`);
}

/** Hand-copy a manifest update; Slack has no scope-change API without xoxe-. */
async function refreshManifestStep(io: SetupIo, prefs: Preferences, appId?: string): Promise<void> {
  const manifest = renderManifest({ appName: prefs.appName });
  const copied = await io.copyToClipboard(manifest);

  io.print(
    `\n${box("Update your Slack app", [
      "This build's manifest may ask for scopes or features your app",
      "does not have yet. Paste it over the existing one, then reinstall.",
    ])}\n\n`,
  );

  if (copied) {
    io.print(`${ok("New manifest copied to your clipboard")}\n\n`);
  } else {
    io.print(
      `${warn("Could not reach a clipboard — paste this yourself:")}\n\n${dim(manifest)}\n\n`,
    );
  }

  io.print(`  ${bold("1.")} App settings → ${bold("App Manifest")} → select all → paste → Save\n`);
  io.print(`  ${bold("2.")} ${bold("Install App")} → Reinstall to Workspace → Allow\n`);
  io.print(`${dim("Slack never grants a new scope to an app that is already installed,")}\n`);
  io.print(`${dim("so step 2 is what actually applies the change.")}\n\n`);

  if (appId) await io.openBrowser(appSettingsUrl(appId, "general"));
  await io.ask("Press Enter once you have saved and reinstalled", "");
}

type CredentialResult =
  | { ok: true; botToken: string; appToken: string; auth: SlackAuth; appId: string | undefined }
  | { ok: false; outcome: Omit<SetupOutcome, "instance"> };

/** Token name shown in Slack's app-level token UI. */
export const APP_TOKEN_NAME = "herdr-slack";

/** Extract app id from an xapp token's third segment. */
export function appIdFromAppToken(token: string): string | undefined {
  const segments = token.split("-");
  const candidate = segments[2];
  return candidate && /^A[A-Z0-9]{6,}$/.test(candidate) ? candidate : undefined;
}

/** Collect app-level token first, then bot token after install. */
async function collectCredentials(
  io: SetupIo,
  prefs: Preferences,
  fetchImpl?: typeof fetch,
): Promise<CredentialResult> {
  const bag = new TokenBag();

  io.print(
    `\n${dim("Slack lands you on Basic Information after Create — the section you need")}\n` +
      `${dim("is already on that page.")}\n\n`,
  );
  io.print(
    `  ${bold("1.")} Scroll to ${bold("App-Level Tokens")} → ${bold("Generate Token and Scopes")}\n`,
  );
  io.print(`  ${bold("2.")} Token Name: ${cyan(APP_TOKEN_NAME)}\n`);
  io.print(`  ${bold("3.")} ${bold("Add Scope")} → ${cyan("connections:write")}\n`);
  io.print(`  ${bold("4.")} ${bold("Generate")} → copy it (starts ${cyan("xapp-")})\n\n`);
  io.print(
    `${tip("Paste below — the input is hidden.")}\n` +
      `${dim("Either token works at either prompt; a swap is kept, not refused.")}\n\n`,
  );

  const appToken = await collectToken(io, "app", bag);
  if (!appToken) {
    return {
      ok: false,
      outcome: {
        status: "needs_admin",
        message: `No app-level token entered. Re-run with: ${command("setup --resume")}`,
      },
    };
  }
  // Prefix alone is insufficient; verify the Socket Mode handshake.
  if (!(await verifyAppToken(appToken, fetchImpl))) {
    return {
      ok: false,
      outcome: {
        status: "abandoned",
        message: "That app-level token could not open a Socket Mode connection.",
      },
    };
  }
  io.print(`${ok("Socket Mode connection verified")}\n`);

  const linkedAppId = appIdFromAppToken(appToken);
  io.print(`\n${bold("Now install the app to your workspace:")}\n\n`);
  io.print(`  ${bold("1.")} Left sidebar → ${bold("Install App")}\n`);
  io.print(`  ${bold("2.")} ${bold("Install to Workspace")} → ${bold("Allow")}\n`);
  io.print(
    `  ${bold("3.")} Copy the ${bold("Bot User OAuth Token")} (starts ${cyan("xoxb-")})\n\n`,
  );
  if (linkedAppId) await io.openBrowser(appSettingsUrl(linkedAppId, "install"));

  const botToken = await collectToken(io, "bot", bag);
  if (!botToken) {
    io.print(`\n${adminRequest({ appName: prefs.appName })}\n`);
    return {
      ok: false,
      outcome: {
        status: "needs_admin",
        message: `No bot token entered. If your workspace requires admin approval, send the request above, then run: ${command("setup --resume")}`,
      },
    };
  }

  const auth = await authTest(botToken, fetchImpl).catch(() => null);
  if (!auth?.ok) {
    return {
      ok: false,
      outcome: { status: "abandoned", message: "That bot token was rejected by Slack." },
    };
  }
  io.print(`${ok(`${bold(auth.team ?? "workspace")} — bot user ${auth.user_id ?? "?"}`)}\n`);

  const appId = linkedAppId ?? (await resolveAppId(botToken, fetchImpl));
  io.print(`${dim("(step 4/6 — both tokens verified)")}\n`);

  return { ok: true, botToken, appToken, auth, appId };
}

interface AcquireInput {
  io: SetupIo;
  mode: SetupMode;
  instance: string;
  prefs: Preferences;
  existing: ReturnType<typeof readExisting>;
  store: SecretStore;
  fetchImpl?: typeof fetch;
}

/** Reuse what is stored when reconfiguring; otherwise collect both tokens. */
async function acquireCredentials(input: AcquireInput): Promise<CredentialResult> {
  const { io, mode, instance, prefs, existing, store, fetchImpl } = input;
  const reused =
    mode === "reconfigure" ? await reuseCredentials(instance, existing, store, fetchImpl) : null;
  if (reused) {
    io.print(`${ok("Reusing the credentials already stored for this instance")}\n`);
    return reused;
  }
  step(io, 3, "Collect both tokens");
  return collectCredentials(io, prefs, fetchImpl);
}

export async function runSetup(options: SetupOptions): Promise<SetupOutcome> {
  const { io, fetchImpl, entrypoint, configFile = configPath(), mode = "fresh" } = options;
  const socketPath = options.socketPath ?? defaultSocketPath();
  const instance = instanceKeyForSocket(socketPath);

  io.print(wizardBanner(instance, mode));
  io.print(`${dim(`herdr socket: ${socketPath}`)}\n`);

  const existing = mode === "fresh" ? undefined : readExisting(instance, configFile);
  // Reconfigure needs stored credentials; resume must work without a config file.
  if (mode === "reconfigure" && !existing) {
    return {
      status: "abandoned",
      instance,
      message: `No existing configuration for "${instance}" to reconfigure. Run: ${command("setup")}`,
    };
  }

  // Marker for the setup popup (ADR 0008); skip on reconfigure.
  if (mode !== "reconfigure") writeSetupStatus(instance, "in_progress");

  step(io, 1, "This instance");
  const prefs = await askPreferences(io, instance, options.noService, existing?.label);

  if (mode === "fresh") {
    step(io, 2, "Create the Slack app");
    await createAppStep(io, prefs);
  } else if (mode === "resume") {
    io.print(
      `\n${tip("Skipping app creation — your Slack app should already exist.")}\n` +
        `${dim("If it does not, choose Reset from the setup menu and start over.")}\n`,
    );
  } else {
    await refreshManifestStep(io, prefs, existing?.slack.appId);
  }

  const store = options.secretStore ?? (await detectSecretStore());
  const credentials = await acquireCredentials({
    io,
    mode,
    instance,
    prefs,
    existing,
    store,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (!credentials.ok) return failCredentials(instance, credentials.outcome);

  step(io, 5, "Who may drive your agents");
  const allowed = await resolveAllowlist(io);
  if (allowed.length === 0) {
    return {
      status: "abandoned",
      instance,
      message: "An allowlist is required — without one, anyone who can DM the bot gets a shell.",
    };
  }

  step(io, 6, "What may leave this machine");
  io.print(DATA_EXPOSURE_NOTICE);
  const contentMode: ContentMode = (await io.confirm(
    "Send terminal output to Slack? (full retention in the workspace)",
    true,
  ))
    ? "full"
    : "summary";
  io.print(
    contentMode === "full"
      ? `${warn("Default applied — terminal output will be sent to this workspace and retained there.")}\n` +
          `${dim("Change it any time: contentMode in config.json, or setup --reconfigure.")}\n`
      : `${ok("Summary mode — statuses and titles only, no terminal text.")}\n` +
          `${dim("Every control still works; you just will not see the output in Slack.")}\n`,
  );

  await persist({
    instance,
    configFile,
    store,
    prefs,
    credentials,
    allowed,
    contentMode,
    socketPath,
    io,
  });

  if (prefs.wantService) {
    await installServiceStep(
      io,
      instance,
      entrypoint,
      options.installServiceFn,
      options.discoverNetworkEnvFn,
      options.enableServiceFn,
    );
  }

  clearSetupStatus(instance);
  await verifyStep(io, instance, configFile, fetchImpl, options.runDoctorFn);

  return {
    status: "complete",
    instance,
    message: `Setup complete. Check it any time with: ${command(`doctor --instance ${instance}`)}`,
  };
}

/** Run doctor at the end; failures are informational only. */
async function verifyStep(
  io: SetupIo,
  instance: string,
  configFile: string,
  fetchImpl?: typeof fetch,
  runDoctorFn: typeof runDoctor = runDoctor,
): Promise<void> {
  io.print(`\n${dim("Checking the whole thing end to end…")}\n\n`);
  try {
    const report = await runDoctorFn({ instance, configFile, ...(fetchImpl ? { fetchImpl } : {}) });
    io.print(`${formatReport(report)}\n`);
  } catch (error) {
    io.print(
      `${warn(`Could not run the checks: ${error instanceof Error ? error.message : String(error)}`)}\n` +
        `${dim(`Run them yourself with: ${command(`doctor --instance ${instance}`)}`)}\n`,
    );
  }
}

/**
 * Install the user service after checking background Slack reachability (ADR 0009).
 */
async function installServiceStep(
  io: SetupIo,
  instance: string,
  entrypoint: string,
  installServiceFn?: typeof installService,
  discoverNetworkEnvFn: typeof discoverNetworkEnv = discoverNetworkEnv,
  enableServiceFn?: typeof enableService,
): Promise<void> {
  const discovered = discoverNetworkEnvFn();
  let networkEnv: NetworkEnv = {};
  if (discovered.kind === "fixed") {
    networkEnv = discovered.env;
    saveNetworkEnv(instance, networkEnv);
    io.print(
      `${tip("This machine needs a TLS override to reach Slack in the background.")}\n` +
        `${dim(`Using ${Object.keys(networkEnv).join(", ")} — saved for the service to use too.`)}\n\n`,
    );
  } else {
    clearNetworkEnv(instance);
    if (discovered.kind === "unreachable") {
      io.print(
        `${warn("Could not find a way for the background service to reach Slack.")}\n` +
          `${dim("It will work while you run it by hand, but not once it is installed as a service.")}\n` +
          `${dim(`Run \`${command("doctor")}\` to see the exact check, or set NODE_EXTRA_CA_CERTS.`)}\n\n`,
      );
    }
  }

  const install = installServiceFn ?? installService;
  const result = install(instance, entrypoint, undefined, undefined, networkEnv);
  io.print(`${ok(`Installed ${result.unit}`)}\n`);

  // Enable the service so setup leaves a running daemon.
  const enabled = (enableServiceFn ?? enableService)(instance);
  io.print(
    enabled.ok
      ? `${ok(`Service started — ${enabled.detail}`)}\n`
      : `${warn(`Installed, but could not start it automatically: ${enabled.detail}`)}\n`,
  );
  if (enabled.followUp.length > 0) {
    io.print(`\n${bold(enabled.ok ? "One thing left to do:" : "Run this by hand:")}\n`);
    for (const line of enabled.followUp) io.print(`  ${cyan(line)}\n`);
    io.print("\n");
  }
}

/** Persist needs_admin so the next popup can offer Continue. */
function failCredentials(instance: string, outcome: Omit<SetupOutcome, "instance">): SetupOutcome {
  if (outcome.status === "needs_admin") writeSetupStatus(instance, "needs_admin");
  return { instance, ...outcome };
}

interface PersistInput {
  instance: string;
  configFile: string;
  store: SecretStore;
  prefs: Preferences;
  credentials: Extract<CredentialResult, { ok: true }>;
  allowed: string[];
  contentMode: ContentMode;
  socketPath: string;
  io: SetupIo;
}

/** Write config; store credentials in the keychain when available. */
async function persist(input: PersistInput): Promise<void> {
  const { instance, configFile, store, prefs, credentials, allowed, contentMode, io } = input;

  if (store.kind === "keychain") {
    await store.set(instance, "botToken", credentials.botToken);
    await store.set(instance, "appToken", credentials.appToken);
  }

  const value: InstanceConfig = defaultInstance({
    label: prefs.label,
    herdrSocketPath: input.socketPath,
    credentialStore: store.kind,
    slack: {
      botToken: store.kind === "keychain" ? "" : credentials.botToken,
      appToken: store.kind === "keychain" ? "" : credentials.appToken,
      teamId: credentials.auth.team_id ?? "",
      appId: credentials.appId ?? "",
      botUserId: credentials.auth.user_id ?? "",
    },
    allowedUsers: allowed,
    contentMode,
  });
  upsertInstance(instance, value, configFile);

  io.print(
    store.kind === "keychain"
      ? `\n${ok(`Credentials stored in the OS keychain; ${configFile} holds no secrets`)}\n`
      : `\n${ok(`Wrote ${configFile} (0600) — no keychain available, so it holds the tokens`)}\n`,
  );
}

function readExisting(instance: string, configFile: string): InstanceConfig | undefined {
  try {
    return readConfigFile(configFile).instances[instance];
  } catch {
    return undefined;
  }
}

/** Reuse stored credentials after verifying they still work. */
async function reuseCredentials(
  instance: string,
  existing: InstanceConfig | undefined,
  store: SecretStore,
  fetchImpl?: typeof fetch,
): Promise<CredentialResult | null> {
  if (!existing) return null;
  const hydrated = await withCredentials(instance, existing, store);
  const { botToken, appToken } = hydrated.slack;
  if (!botToken || !appToken) return null;

  const auth = await authTest(botToken, fetchImpl).catch(() => null);
  if (!auth?.ok) return null;
  if (!(await verifyAppToken(appToken, fetchImpl))) return null;

  return { ok: true, botToken, appToken, auth, appId: existing.slack.appId || undefined };
}

/** auth.test does not return an app id; bots.info does, via the bot id. */
async function resolveAppId(token: string, fetchImpl?: typeof fetch): Promise<string | undefined> {
  try {
    const auth = await authTest(token, fetchImpl);
    if (!auth.bot_id) return undefined;
    const info = await slackCall<{ bot?: { app_id?: string } }>({
      token,
      method: "bots.info",
      body: { bot: auth.bot_id },
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    return info.bot?.app_id;
  } catch {
    return undefined;
  }
}

/** Where Slack hides the member ID we need. Bot tokens cannot discover this for you. */
const ALLOWLIST_HELP = `
Anyone on this list can type into your terminals, so it is normally just you.

A bot token cannot tell us which human is running setup, so paste your Slack
member ID (starts with U…):

  Profile (avatar, top right) → ⋮ More → Copy member ID

Several people: comma-separate the IDs.
`;

const looksLikeUserId = (value: string): boolean => /^[UW][A-Z0-9]{6,}$/.test(value);

/** Collect allowlisted Slack member IDs — no handle resolution, no roster. */
async function resolveAllowlist(io: SetupIo): Promise<string[]> {
  io.print(ALLOWLIST_HELP);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const typed = (await io.ask("Member ID(s) who may drive agents", "")).trim();
    if (!typed) {
      io.print("Paste at least one member ID (U…).\n");
      continue;
    }

    const ids: string[] = [];
    const unknown: string[] = [];
    for (const part of typed
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)) {
      if (looksLikeUserId(part)) {
        ids.push(part);
        io.print(`✓ ${part}\n`);
      } else {
        unknown.push(part);
      }
    }

    if (unknown.length > 0) {
      io.print(
        `Not a member ID (need U… / W…): ${unknown.join(", ")}\n` +
          `${dim("Handles and display names are not accepted.")}\n`,
      );
    }
    if (ids.length > 0) return [...new Set(ids)];
  }
  return [];
}

/*
 * Real terminal IO excluded from coverage; runSetup is tested via SetupIo fakes.
 */
/* v8 ignore start */
/** Read a line without echoing it; raw mode avoids readline echo bugs. */
/** One readline interface per prompt so readHidden can own stdin. */
function applyKey(ch: string, buffer: string): string | null | undefined {
  if (ch === "\r" || ch === "\n") return null;
  if (ch === "\u0003" || ch === "\u0004") return undefined;
  if (ch === "\u007f" || ch === "\b") {
    if (!buffer) return buffer;
    process.stdout.write("\b \b");
    return buffer.slice(0, -1);
  }
  process.stdout.write("•");
  return buffer + ch;
}

async function readHidden(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return (await question("")).trim();

  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise<string>((resolve) => {
    let buffer = "";
    const finish = (value: string) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const next = applyKey(ch, buffer);
        if (next === null) return finish(buffer);
        if (next === undefined) return finish("");
        buffer = next;
      }
    };
    input.on("data", onData);
  });
}

/** One readline interface per prompt. */
async function question(text: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(text);
  } finally {
    rl.close();
  }
}

export function terminalIo(): SetupIo {
  return {
    print: (text) => process.stdout.write(text),
    ask: async (q, fallback = "") => {
      const answer = (await question(`❯ ${q}${fallback ? ` [${fallback}]` : ""}: `)).trim();
      return answer || fallback;
    },
    confirm: async (q, fallbackYes) => {
      const answer = (await question(`❯ ${q} ${fallbackYes ? "[Y/n]" : "[y/N]"}: `))
        .trim()
        .toLowerCase();
      if (!answer) return fallbackYes;
      return answer.startsWith("y");
    },
    openBrowser: async (url) => {
      const { execFile } = await import("node:child_process");
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      try {
        execFile(opener, [url]);
      } catch {
        // Browser open failure is non-fatal; the URL is printed too.
      }
    },
    copyToClipboard: (text) => writeClipboard(text),
    askSecret: async (q) => {
      process.stdout.write(`❯ ${q}: `);
      const answer = await readHidden();
      process.stdout.write("\n");
      return answer;
    },
  };
}
/* v8 ignore stop */
