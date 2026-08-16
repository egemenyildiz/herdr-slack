#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { ConfigError, readConfigFile, resolveInstance } from "./config/config.js";
import { formatReport, runDoctor } from "./config/doctor.js";
import { configPath, instanceKeyForSocket, stateDir } from "./config/instance.js";
import { offerSetup, openResetPane, runSetupPane } from "./config/setup-offer.js";
import { runSetup, terminalIo } from "./config/setup.js";
import { renderLine } from "./daemon/logger.js";
import { isRunning, logPath, readRecord, spawnDetached } from "./daemon/supervisor.js";
import { devRecord } from "./dev/record.js";
import { devTail } from "./dev/tail.js";
import { HerdrClient, defaultSocketPath } from "./herdr/client.js";
import { HerdrError } from "./herdr/types.js";

const USAGE = `herdr-slack — drive your local herdr agents from Slack

Setup
  herdr-slack setup [--socket <path>] [--no-service]
  herdr-slack setup --resume        Continue after workspace admin approval
  herdr-slack setup --reconfigure   Change settings, keeping existing credentials
  herdr-slack setup --offer         Startup hook: open setup popup if needed
  herdr-slack setup --open          Always open the setup popup (workspace action)
  herdr-slack setup --pane          Interactive popup body (do not run by hand)
  herdr-slack doctor [--instance <key>] [--json] [--offline]
  herdr-slack reset --yes [--instance <key>]  Undo setup on this machine
  herdr-slack reset --open                    Open the reset popup (workspace action)
  herdr-slack reset --pane                    Popup body (do not run by hand)

Daemon
  herdr-slack daemon run --instance <key>     Foreground; what the service runs
  herdr-slack daemon run --dry-run            Render every Slack write, send none
  herdr-slack daemon ensure                   Idempotent start (herdr startup hook)
  herdr-slack daemon start|stop|restart|status|logs [-f] [--instance <key>]

Development
  herdr-slack dev tail [--socket <path>]      Live dashboard from the event stream
  herdr-slack dev record <out.ndjson>         Capture events as a test fixture
  herdr-slack ping [--socket <path>]
`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

const has = (argv: string[], name: string): boolean => argv.includes(name);

/** `--instance` wins; else derive from socket. One of two HERDR_SOCKET_PATH readers (ADR 0002). */
function resolveInstanceKey(argv: string[]): string {
  const explicit = flag(argv, "--instance");
  if (explicit) return explicit;
  const socket = flag(argv, "--socket") ?? process.env.HERDR_SOCKET_PATH ?? defaultSocketPath();
  return instanceKeyForSocket(socket);
}

function entrypoint(): string {
  return new URL(import.meta.url).pathname;
}

async function daemonRun(instance: string, dryRun: boolean): Promise<number> {
  const { runDaemon } = await import("./daemon/run.js");
  return runDaemon(instance, { dryRun });
}

async function daemonEnsure(instance: string): Promise<number> {
  if (!(await isRunning(instance))) spawnDetached(instance);
  return 0;
}

async function daemonStart(instance: string): Promise<number> {
  if (await isRunning(instance)) {
    process.stdout.write(`already running (instance ${instance})\n`);
    return 0;
  }
  spawnDetached(instance);
  process.stdout.write(`started (instance ${instance})\n`);
  return 0;
}

async function daemonRestart(instance: string): Promise<number> {
  if ((await daemonStop(instance)) !== 0) {
    process.stderr.write("the old daemon is still holding the lock; not starting a second\n");
    return 1;
  }
  return daemonStart(instance);
}

async function daemonStop(instance: string): Promise<number> {
  const record = readRecord(instance);
  if (!record?.pid || !(await isRunning(instance))) {
    process.stdout.write("not running\n");
    return 0;
  }
  try {
    process.kill(record.pid, "SIGTERM");
    process.stdout.write(`sent SIGTERM to ${record.pid}\n`);
  } catch {
    process.stderr.write("could not signal the daemon; it may have already exited\n");
    return 0;
  }

  for (let attempt = 0; attempt < 60 && (await isRunning(instance)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (await isRunning(instance)) {
    process.stderr.write("it is taking longer than expected to exit\n");
    return 1;
  }
  return 0;
}

async function daemonStatus(instance: string, json: boolean): Promise<number> {
  const running = await isRunning(instance);
  const record = readRecord(instance);
  const status = {
    instance,
    running,
    pid: record?.pid ?? null,
    startedAt: record?.startedAt ?? null,
    socketPath: record?.socketPath ?? null,
    version: record?.version ?? null,
  };
  process.stdout.write(
    json
      ? `${JSON.stringify(status, null, 2)}\n`
      : `instance ${instance}: ${running ? `running (pid ${status.pid})` : "not running"}\n`,
  );
  return running ? 0 : 1;
}

/** Read the tail of a file without pulling a 5 MB log into memory. */
function tailBytes(file: string, maxBytes: number): string {
  const size = statSync(file).size;
  if (size <= maxBytes) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    readSync(fd, buffer, 0, maxBytes, size - maxBytes);
    return buffer.toString("utf8").slice(buffer.toString("utf8").indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
}

function printLog(text: string, raw: boolean): void {
  const lines = text.split("\n");
  const rendered = raw ? lines : lines.map((line) => (line ? renderLine(line) : line));
  process.stdout.write(rendered.join("\n"));
}

async function daemonLogs(
  instance: string,
  options: { follow: boolean; raw: boolean },
): Promise<number> {
  const file = logPath(instance);
  if (!existsSync(file)) {
    if (!options.follow) {
      process.stderr.write(`no log yet at ${file}\n`);
      return 1;
    }
    process.stderr.write(`waiting for ${file}\n`);
  } else {
    printLog(tailBytes(file, 256 * 1024), options.raw);
  }
  if (!options.follow) return 0;

  // Poll, not fs.watch — rotation renames the file and watchers keep stale inodes.
  let offset = existsSync(file) ? statSync(file).size : 0;
  setInterval(() => {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size === offset) return;
    if (size < offset) offset = 0;
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      printLog(buffer.toString("utf8"), options.raw);
    } finally {
      closeSync(fd);
    }
    offset = size;
  }, 500);

  await new Promise<void>(() => undefined);
  return 0;
}

async function cmdDaemon(argv: string[]): Promise<number> {
  const sub = argv[1] ?? "status";
  const instance = resolveInstanceKey(argv);

  switch (sub) {
    case "run":
      return daemonRun(instance, has(argv, "--dry-run"));
    case "ensure":
      return daemonEnsure(instance);
    case "start":
      return daemonStart(instance);
    case "stop":
      return daemonStop(instance);
    case "restart":
      return daemonRestart(instance);
    case "status":
      return daemonStatus(instance, has(argv, "--json"));
    case "logs":
      return daemonLogs(instance, {
        follow: has(argv, "-f") || has(argv, "--follow"),
        raw: has(argv, "--json"),
      });
    default:
      process.stderr.write(`unknown daemon command: ${sub}\n`);
      return 2;
  }
}

type Command = (argv: string[]) => Promise<number>;

async function cmdSetup(argv: string[]): Promise<number> {
  const socket = flag(argv, "--socket");

  if (has(argv, "--offer") || has(argv, "--open")) {
    const result = offerSetup({
      instance: resolveInstanceKey(argv),
      force: has(argv, "--open"),
    });
    if (result.reason === "open_failed") {
      process.stderr.write(`setup offer: ${result.detail}\n`);
      return 0;
    }
    return 0;
  }

  if (has(argv, "--pane")) {
    const outcome = await runSetupPane({
      io: terminalIo(),
      entrypoint: entrypoint(),
      ...(socket ? { socketPath: socket } : {}),
      ...(has(argv, "--no-service") ? { noService: true } : {}),
    });
    process.stdout.write(`\n${outcome.message}\n`);
    return outcome.status === "complete" ? 0 : 1;
  }

  const mode = has(argv, "--resume")
    ? "resume"
    : has(argv, "--reconfigure")
      ? "reconfigure"
      : "fresh";
  const outcome = await runSetup({
    io: terminalIo(),
    entrypoint: entrypoint(),
    mode,
    ...(socket ? { socketPath: socket } : {}),
    ...(has(argv, "--no-service") ? { noService: true } : {}),
  });
  process.stdout.write(`\n${outcome.message}\n`);
  return outcome.status === "complete" ? 0 : 1;
}

async function cmdReset(argv: string[]): Promise<number> {
  if (has(argv, "--open")) {
    const result = openResetPane();
    if (!result.ok) {
      process.stderr.write(`reset pane: ${result.detail}\n`);
      return 1;
    }
    return 0;
  }

  const instance = resolveInstanceKey(argv);
  const { runReset } = await import("./config/reset.js");
  const inPane = has(argv, "--pane");

  if (!has(argv, "--yes") && !inPane) {
    process.stdout.write(`This removes instance "${instance}":
  · its entries in the OS keychain
  · its section of ${configPath()}
  · ${stateDir(instance)}
  · its launchd/systemd user service

The Slack app itself is not touched — delete it at api.slack.com/apps.

Re-run with --yes to do it.\n`);
    return 1;
  }

  if (await isRunning(instance)) {
    process.stdout.write("Stopping the daemon first…\n");
    if ((await daemonStop(instance)) !== 0) {
      process.stderr.write(
        "refusing to reset while the daemon is still running — it would rewrite the state\n" +
          "directory as it shuts down. Stop it and try again.\n",
      );
      return 1;
    }
  }

  const result = await runReset({ instance });
  for (const line of result.removed) process.stdout.write(`  removed ${line}\n`);
  if (result.removed.length === 0) process.stdout.write("  nothing to remove\n");
  for (const line of result.kept) process.stdout.write(`\nStill there: ${line}\n`);
  if (inPane) {
    await terminalIo().ask("\nPress Enter to close");
  }
  return 0;
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const report = await runDoctor({
    instance: resolveInstanceKey(argv),
    ...(has(argv, "--offline") ? { offline: true } : {}),
  });
  process.stdout.write(
    has(argv, "--json") ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`,
  );
  return report.ok ? 0 : 1;
}

async function cmdDev(argv: string[]): Promise<number> {
  const socket = flag(argv, "--socket");
  if (argv[1] === "tail") return devTail(socket);
  if (argv[1] === "record") {
    const out = argv[2];
    if (!out || out.startsWith("--")) {
      process.stderr.write("dev record needs an output path\n");
      return 2;
    }
    return devRecord(out, socket ?? defaultSocketPath());
  }
  process.stderr.write(`unknown dev command: ${argv[1] ?? ""}\n`);
  return 2;
}

/** Resolve through config where possible, so ping checks the daemon's socket. */
function pingTarget(argv: string[]): string {
  const explicit = flag(argv, "--socket");
  if (explicit) return explicit;
  try {
    return resolveInstance(readConfigFile(configPath()), resolveInstanceKey(argv)).herdrSocketPath;
  } catch {
    return defaultSocketPath();
  }
}

async function cmdPing(argv: string[]): Promise<number> {
  const target = pingTarget(argv);
  const alive = await new HerdrClient(target).ping();
  process.stdout.write(alive ? `herdr: ok (${target})\n` : `herdr: unreachable (${target})\n`);
  return alive ? 0 : 1;
}

const COMMANDS: Record<string, Command> = {
  setup: cmdSetup,
  doctor: cmdDoctor,
  reset: cmdReset,
  daemon: cmdDaemon,
  dev: cmdDev,
  ping: cmdPing,
};

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || has(argv, "--help") || has(argv, "-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const command = COMMANDS[argv[0] ?? ""];
  if (!command) {
    process.stderr.write(`unknown command: ${argv.join(" ")}\n\n${USAGE}`);
    return 2;
  }
  return command(argv);
}

const invokedDirectly = process.argv[1]?.endsWith("cli.js");
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof ConfigError) {
        process.stderr.write(`${error.message}\n`);
        if (error.fix) process.stderr.write(`  fix: ${error.fix}\n`);
        process.exit(1);
      }
      if (error instanceof HerdrError) {
        process.stderr.write(`herdr: ${error.message}\n`);
        process.exit(1);
      }
      process.stderr.write(`${String(error)}\n`);
      process.exit(1);
    });
}
