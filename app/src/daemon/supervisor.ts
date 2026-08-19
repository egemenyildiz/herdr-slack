import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { stateDir } from "../config/instance.js";
import { loadNetworkEnv } from "../config/network-env.js";

export interface DaemonRecord {
  pid: number;
  instance: string;
  socketPath: string;
  startedAt: string;
  version: string;
  slackTeamId?: string;
}

export function lockPath(instance: string): string {
  return path.join(stateDir(instance), "daemon.lock");
}

export function recordPath(instance: string): string {
  return path.join(stateDir(instance), "daemon.json");
}

export function logPath(instance: string): string {
  return path.join(stateDir(instance), "daemon.log");
}

/** Crash output from the detached daemon, which has no terminal to print to. */
export function stderrPath(instance: string): string {
  return path.join(stateDir(instance), "daemon.err");
}

function ensureStateDir(instance: string): string {
  const dir = stateDir(instance);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Acquire the single-daemon lock, or return null if another holds it.
 *
 * Node has no `fs.flock`, and a native addon is unacceptable here: `npm ci
 * --omit=dev` runs on user machines during `herdr plugin install`, and requiring
 * node-gyp there would make installation fail on any machine without a compiler.
 * proper-lockfile is pure JS (atomic mkdir plus an mtime heartbeat).
 *
 * `run` is the only process that ever takes this lock. A loser exits 0 quietly,
 * which is what makes concurrent `ensure` calls benign — there is no window
 * where a parent releases a lock before its child acquires one.
 */
export async function acquireLock(instance: string): Promise<(() => Promise<void>) | null> {
  const dir = ensureStateDir(instance);
  const target = lockPath(instance);
  if (!existsSync(target)) writeFileSync(target, "", { mode: 0o600 });
  try {
    const release = await lockfile.lock(target, {
      realpath: false,
      // If a daemon is SIGKILLed the lock survives; the heartbeat lets a later
      // start reclaim it instead of wedging the instance forever.
      stale: 30_000,
      update: 10_000,
    });
    void dir;
    return release;
  } catch {
    return null;
  }
}

export async function isRunning(instance: string): Promise<boolean> {
  const target = lockPath(instance);
  if (!existsSync(target)) return false;
  try {
    return await lockfile.check(target, { realpath: false, stale: 30_000 });
  } catch {
    return false;
  }
}

export function writeRecord(record: DaemonRecord): void {
  ensureStateDir(record.instance);
  writeFileSync(recordPath(record.instance), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function readRecord(instance: string): DaemonRecord | null {
  const file = recordPath(instance);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DaemonRecord;
  } catch {
    return null;
  }
}

/**
 * Start `daemon run` detached and return immediately.
 *
 * This is what herdr's `[[startup]]` hook calls. It must exit fast and it must
 * never hold the lock itself — the child takes it, and if another daemon already
 * has it the child exits 0 quietly.
 *
 * Excluded from coverage: it spawns a real detached process. The guarantee that
 * matters — exactly one lock holder, losers exit quietly — is covered in
 * supervisor.test.ts against the lock itself.
 */
/* v8 ignore start */
/**
 * Spawn the detached daemon for `daemon start`/`daemon ensure`.
 *
 * Merges in whatever `setup` recorded as needed for outbound HTTPS (ADR 0009).
 * The service unit gets this baked into its shim as real `export` lines, but
 * this path is `daemon ensure`'s spawn from herdr's `[[startup]]` hook, running
 * under whatever ambient environment herdr passed the hook — a second, separate
 * place the same override can be missing.
 */
export function spawnDetached(instance: string, execPath = process.execPath): number | undefined {
  ensureStateDir(instance);
  const entry = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");
  // A discarded stderr makes a crash-on-boot indistinguishable from a daemon
  // that started and went quiet, so keep it even though the log is ndjson.
  const errors = openSync(stderrPath(instance), "a", 0o600);
  const child = spawn(execPath, [entry, "daemon", "run", "--instance", instance], {
    detached: true,
    stdio: ["ignore", errors, errors],
    env: { ...process.env, ...loadNetworkEnv(instance) },
  });
  child.unref();
  return child.pid;
}

/* v8 ignore stop */

/**
 * Wire up graceful shutdown.
 *
 * Exiting 0 on an intentional stop matters on both platforms: launchd's
 * KeepAlive={SuccessfulExit:false} and systemd's Restart=on-failure both treat a
 * clean exit as "do not restart". Exiting non-zero here would make `daemon stop`
 * silently bounce. Every other death must exit non-zero so the service manager
 * brings the daemon back — that is what `installProcessGuards` enforces.
 */
export function onShutdown(handler: () => Promise<void> | void): void {
  let shuttingDown = false;
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await handler();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export interface ProcessGuardLog {
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Keep the daemon alive through stray async failures, and die loudly for the
 * ones that leave process state undefined.
 *
 * Node's default for an unhandled rejection is to crash. That is how a wiped
 * shared registry (or a Bolt frame handler rejecting with `undefined`) left
 * Slack with no Socket Mode owner and a `KeepAlive` that would not restart —
 * launchd recorded exit 0 after a prior clean stop, and the crash path never
 * got another chance. Logging and continuing is the right call for a rejection:
 * the tick that failed will try again. An uncaught sync exception is different;
 * exit 1 so the service manager restarts into a clean process.
 */
export function installProcessGuards(log: ProcessGuardLog): void {
  process.on("unhandledRejection", (reason) => {
    const message =
      reason instanceof Error
        ? reason.message
        : reason === undefined
          ? "undefined"
          : String(reason);
    log.error("daemon.unhandled_rejection", { message });
  });
  process.on("uncaughtException", (error) => {
    log.error("daemon.uncaught_exception", {
      message: error.message,
      ...(error.name ? { name: error.name } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    });
    process.exit(1);
  });
}
