import { spawnSync } from "node:child_process";
import { defaultSocketPath } from "../herdr/client.js";
import { configPath, instanceKeyForSocket } from "./instance.js";
import { runReset } from "./reset.js";
import {
  classifySetupOffer,
  clearSetupStatus,
  readSetupStatus,
  writeSetupStatus,
} from "./setup-status.js";
import { bold, dim } from "./setup-style.js";
import { type SetupIo, type SetupMode, type SetupOutcome, runSetup } from "./setup.js";

const PLUGIN_ID = "herdr-slack";
const SETUP_ENTRYPOINT = "setup";
const RESET_ENTRYPOINT = "reset";

/** Carried into a freshly opened setup pane after Continue / Reset. */
export const SETUP_MODE_ENV = "HERDR_SLACK_SETUP_MODE";

export interface OfferOptions {
  instance?: string;
  configFile?: string;
  /** Open even when configured or dismissed (manual action). */
  force?: boolean;
  /** Override for tests. Defaults to spawning `herdr plugin pane open`. */
  openPane?: (instance: string) => { ok: boolean; detail: string };
  herdrBin?: string;
}

export interface OfferResult {
  /** Whether a pane open was attempted. */
  opened: boolean;
  reason: "configured" | "dismissed" | "opened" | "open_failed";
  detail: string;
}

/**
 * Startup-hook entry: open the setup popup when this instance still needs one.
 *
 * Never interactive itself — herdr startup has no guaranteed TTY (ADR 0008).
 * Pass `force: true` from the workspace action so dismiss / already-configured
 * still open the pane (configured shows a short message inside).
 */
export function offerSetup(options: OfferOptions = {}): OfferResult {
  const configFile = options.configFile ?? configPath();
  const instance =
    options.instance ?? instanceKeyForSocket(process.env.HERDR_SOCKET_PATH ?? defaultSocketPath());
  const kind = classifySetupOffer(instance, configFile);

  if (!options.force) {
    if (kind === "configured") {
      return { opened: false, reason: "configured", detail: "already configured" };
    }
    if (kind === "dismissed") {
      return { opened: false, reason: "dismissed", detail: "setup offer dismissed" };
    }
  }

  if (kind === "dismissed") clearSetupStatus(instance);

  const open = options.openPane ?? ((id) => openSetupPane(id, options.herdrBin));
  const result = open(instance);
  if (!result.ok) {
    return { opened: false, reason: "open_failed", detail: result.detail };
  }
  return { opened: true, reason: "opened", detail: result.detail };
}

/** Open the manifest `setup` popup. Placement comes from herdr-plugin.toml. */
export function openSetupPane(
  _instance: string,
  herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
  env: Record<string, string> = {},
): { ok: boolean; detail: string } {
  return openPluginPane(SETUP_ENTRYPOINT, "setup", herdrBin, env);
}

/** Open the manifest `reset` popup from its workspace action. */
export function openResetPane(herdrBin = process.env.HERDR_BIN_PATH ?? "herdr"): {
  ok: boolean;
  detail: string;
} {
  return openPluginPane(RESET_ENTRYPOINT, "reset", herdrBin);
}

function openPluginPane(
  entrypoint: string,
  label: string,
  herdrBin: string,
  env: Record<string, string> = {},
): { ok: boolean; detail: string } {
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    entrypoint,
    "--focus",
  ];
  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }
  const result = spawnSync(herdrBin, args, { encoding: "utf8", env: process.env });
  if (result.error) {
    return { ok: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const text = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { ok: false, detail: text || `herdr exited ${result.status}` };
  }
  return { ok: true, detail: `opened ${label} pane` };
}

export interface PaneOptions {
  io: SetupIo;
  entrypoint: string;
  socketPath?: string;
  configFile?: string;
  noService?: boolean;
  runSetupFn?: typeof runSetup;
  runResetFn?: typeof runReset;
  /**
   * Test / forced-mode hook. When set (or via {@link SETUP_MODE_ENV}), skip the
   * incomplete menu and run the wizard in that mode.
   */
  forcedMode?: SetupMode;
  /** Override for tests: reopen setup in a clean pane after continue/reset. */
  relaunch?: (mode: SetupMode) => { ok: boolean; detail: string };
  herdrBin?: string;
}

export function parseForcedSetupMode(value: string | undefined): SetupMode | undefined {
  if (value === "fresh" || value === "resume" || value === "reconfigure") return value;
  return undefined;
}

/** Clear the visible terminal + scrollback so a fallback in-pane restart feels fresh. */
export function clearPaneScreen(io: SetupIo): void {
  io.print("\x1b[2J\x1b[3J\x1b[H");
}

/**
 * Interactive popup entry: menu when incomplete, otherwise the wizard.
 *
 * Continue / Reset reopen a fresh setup pane (forced mode via env) so the
 * wizard does not scroll under the unfinished-setup menu.
 */
export async function runSetupPane(options: PaneOptions): Promise<SetupOutcome> {
  const { io, entrypoint } = options;
  const configFile = options.configFile ?? configPath();
  const socketPath = options.socketPath ?? process.env.HERDR_SOCKET_PATH ?? defaultSocketPath();
  const instance = instanceKeyForSocket(socketPath);
  const forcedMode =
    options.forcedMode ?? parseForcedSetupMode(process.env[SETUP_MODE_ENV] ?? undefined);

  if (forcedMode) {
    return (options.runSetupFn ?? runSetup)({
      io,
      entrypoint,
      mode: forcedMode,
      configFile,
      socketPath,
      ...(options.noService ? { noService: true } : {}),
    });
  }

  const kind = classifySetupOffer(instance, configFile);

  if (kind === "configured") {
    return {
      status: "abandoned",
      instance,
      message:
        `Instance "${instance}" is already set up. Reconfigure with: herdr-slack setup --reconfigure\n` +
        `Or wipe it with: herdr-slack reset --yes --instance ${instance}`,
    };
  }

  if (kind === "incomplete") {
    const marker = readSetupStatus(instance);
    const choice = await askIncompleteMenu(io);
    if (choice === "dismiss") {
      writeSetupStatus(instance, "dismissed");
      return {
        status: "abandoned",
        instance,
        message: "Okay — run herdr plugin action invoke setup --plugin herdr-slack when ready.",
      };
    }

    // needs_admin → resume (app already created). in_progress → fresh so
    // create-app / clipboard / browser still run — Continue used to skip them.
    let mode: SetupMode = marker?.status === "needs_admin" ? "resume" : "fresh";
    if (choice === "reset") {
      await (options.runResetFn ?? runReset)({ instance, configFile });
      clearSetupStatus(instance);
      mode = "fresh";
    }

    return relaunchOrRun(mode, options, instance, configFile, socketPath);
  }

  return (options.runSetupFn ?? runSetup)({
    io,
    entrypoint,
    mode: "fresh",
    configFile,
    socketPath,
    ...(options.noService ? { noService: true } : {}),
  });
}

async function relaunchOrRun(
  mode: SetupMode,
  options: PaneOptions,
  instance: string,
  configFile: string,
  socketPath: string,
): Promise<SetupOutcome> {
  const { io, entrypoint } = options;
  const relaunch =
    options.relaunch ??
    ((next: SetupMode) => openSetupPane(instance, options.herdrBin, { [SETUP_MODE_ENV]: next }));

  const opened = relaunch(mode);
  if (opened.ok) {
    // Exit this pane quietly; the new popup owns the wizard.
    return {
      status: "complete",
      instance,
      message: "Opening a fresh setup pane…",
    };
  }

  // Herdr could not reopen the pane — clear this TTY and continue in place.
  io.print(
    `${dim(`Could not refresh the pane (${opened.detail}); clearing this screen instead.`)}\n`,
  );
  clearPaneScreen(io);
  return (options.runSetupFn ?? runSetup)({
    io,
    entrypoint,
    mode,
    configFile,
    socketPath,
    ...(options.noService ? { noService: true } : {}),
  });
}

type IncompleteChoice = "continue" | "reset" | "dismiss";

async function askIncompleteMenu(io: SetupIo): Promise<IncompleteChoice> {
  io.print(`\n${bold("Setup for this instance was not finished.")}\n\n`);
  io.print(`  ${bold("1.")} Continue where you left off\n`);
  io.print(`  ${bold("2.")} Reset and start from scratch\n`);
  io.print(`  ${bold("3.")} Not now\n\n`);
  io.print(
    `${dim("Tip: if you never created the Slack app, pick 1 — we will open that step again.")}\n\n`,
  );
  for (;;) {
    const answer = (await io.ask("Choose [1/2/3]", "1")).trim();
    if (answer === "1" || /^c(ontinue)?$/i.test(answer)) return "continue";
    if (answer === "2" || /^r(eset)?$/i.test(answer)) return "reset";
    if (answer === "3" || /^n(ot now)?$/i.test(answer)) return "dismiss";
    io.print("Please enter 1, 2, or 3.\n");
  }
}
