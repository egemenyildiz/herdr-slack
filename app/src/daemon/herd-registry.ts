/**
 * Shared herd registry for one Slack app backed by many herdr sources.
 *
 * Each daemon writes a heartbeat here. Exactly one daemon (the primary) owns
 * Socket Mode and Home for a given Slack appId; the others run as satellites
 * and take work from the command queue. The directory can live on the same
 * machine (including `/Users/Shared/...` across macOS accounts) or on a mount
 * reachable from a remote host — the format does not care where herdr runs.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { TailStatus } from "../herdr/events.js";
import type { AgentStatus } from "../herdr/types.js";

/** How long a heartbeat may sit before the herd is treated as gone. */
export const HEARTBEAT_STALE_MS = 20_000;
/** How often daemons rewrite their heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** Ownership is reclaimed if the primary stops refreshing. */
export const OWNERSHIP_STALE_MS = 25_000;

export interface HerdAgentSnapshot {
  ref: string;
  terminalId: string;
  agent: string;
  title: string;
  cwd: string;
  status: AgentStatus;
  workspaceLabel: string;
  permalink?: string;
}

export interface HerdHeartbeat {
  /** Stable across restarts for this daemon+instance. */
  herdId: string;
  label: string;
  pid: number;
  instance: string;
  socketPath: string;
  appId: string;
  teamId: string;
  herdrStatus: TailStatus;
  agents: HerdAgentSnapshot[];
  updatedAt: number;
  role: "primary" | "satellite";
  hostname: string;
  user: string;
}

export interface SlackOwnership {
  herdId: string;
  pid: number;
  appId: string;
  updatedAt: number;
}

export type HerdCommandOp = "open_session" | "refresh" | "end_session" | "prompt" | "menu_choice";

export interface HerdCommand {
  id: string;
  op: HerdCommandOp;
  herdId: string;
  ref: string;
  channel: string;
  userId: string;
  /** Prompt text or menu digit, when relevant. */
  text?: string;
  createdAt: number;
}

export interface HerdCommandResult {
  id: string;
  ok: boolean;
  message?: string;
  completedAt: number;
}

/** Default registry root: per-user, same place as plugin config. */
export function defaultHerdRegistryDir(configDir: string): string {
  return path.join(configDir, "herd-registry");
}

/** Stable id for this OS user + hostname + instance key. */
export function deriveHerdId(
  instance: string,
  hostname = os.hostname(),
  user = os.userInfo().username,
): string {
  return `${hostname}:${user}:${instance}`;
}

/**
 * Encode a Home/Open button value so the primary can route to another herd.
 * Local (primary) agents keep a bare ref for backwards compatibility.
 */
export function encodeHerdRef(herdId: string, ref: string, localHerdId: string): string {
  if (!ref) return "";
  if (herdId === localHerdId) return ref;
  return `${herdId}\u001f${ref}`;
}

export function decodeHerdRef(value: string, localHerdId: string): { herdId: string; ref: string } {
  const separator = value.indexOf("\u001f");
  if (separator <= 0) return { herdId: localHerdId, ref: value };
  return { herdId: value.slice(0, separator), ref: value.slice(separator + 1) };
}

export class HerdRegistry {
  constructor(readonly root: string) {
    mkdirSync(this.#heartbeatsDir(), { recursive: true, mode: 0o777 });
    mkdirSync(this.#commandsDir(), { recursive: true, mode: 0o777 });
    mkdirSync(this.#resultsDir(), { recursive: true, mode: 0o777 });
    // Cross-account Shared dirs need to stay group/world-writable for peers.
    try {
      writeFileSync(path.join(this.root, ".writable"), `${Date.now()}\n`, { mode: 0o666 });
    } catch {
      // Read-only mounts still allow reading peer heartbeats.
    }
  }

  #heartbeatsDir(): string {
    return path.join(this.root, "heartbeats");
  }

  #commandsDir(): string {
    return path.join(this.root, "commands");
  }

  #resultsDir(): string {
    return path.join(this.root, "results");
  }

  #ownershipPath(appId: string): string {
    return path.join(this.root, `ownership-${sanitize(appId)}.json`);
  }

  #ownershipLockPath(appId: string): string {
    return path.join(this.root, `ownership-${sanitize(appId)}.lock`);
  }

  writeHeartbeat(heartbeat: HerdHeartbeat): void {
    const file = path.join(this.#heartbeatsDir(), `${sanitize(heartbeat.herdId)}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(heartbeat)}\n`, { mode: 0o666 });
    renameSync(tmp, file);
  }

  /** Live heartbeats for this Slack app, freshest first. */
  listHeartbeats(appId: string, now = Date.now()): HerdHeartbeat[] {
    if (!existsSync(this.#heartbeatsDir())) return [];
    const rows: HerdHeartbeat[] = [];
    for (const name of readdirSync(this.#heartbeatsDir())) {
      if (!name.endsWith(".json")) continue;
      const parsed = this.#readJson<HerdHeartbeat>(path.join(this.#heartbeatsDir(), name));
      if (!parsed) continue;
      if (parsed.appId !== appId) continue;
      if (now - parsed.updatedAt > HEARTBEAT_STALE_MS) continue;
      rows.push(parsed);
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt || a.label.localeCompare(b.label));
  }

  removeHeartbeat(herdId: string): void {
    const file = path.join(this.#heartbeatsDir(), `${sanitize(herdId)}.json`);
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }

  /**
   * Claim or renew Slack ownership for this app.
   *
   * Returns true when this herd is (or becomes) the primary. A live foreign
   * owner blocks the claim; a stale owner is replaced.
   */
  async claimOwnership(input: {
    appId: string;
    herdId: string;
    pid: number;
    now?: number;
  }): Promise<boolean> {
    const now = input.now ?? Date.now();
    const lockTarget = this.#ownershipLockPath(input.appId);
    if (!existsSync(lockTarget)) writeFileSync(lockTarget, "", { mode: 0o666 });

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(lockTarget, {
        realpath: false,
        stale: OWNERSHIP_STALE_MS,
        update: 5_000,
      });
    } catch {
      // Another claimant holds the lock; read and see if we already own it.
      const current = this.readOwnership(input.appId);
      return current?.herdId === input.herdId;
    }

    try {
      const current = this.readOwnership(input.appId);
      if (
        current &&
        current.herdId !== input.herdId &&
        now - current.updatedAt < OWNERSHIP_STALE_MS &&
        isPidAlive(current.pid)
      ) {
        return false;
      }
      const next: SlackOwnership = {
        herdId: input.herdId,
        pid: input.pid,
        appId: input.appId,
        updatedAt: now,
      };
      writeFileSync(this.#ownershipPath(input.appId), `${JSON.stringify(next)}\n`, { mode: 0o666 });
      return true;
    } finally {
      await release?.();
    }
  }

  /** Refresh the ownership timestamp while remaining primary. */
  renewOwnership(appId: string, herdId: string, pid: number, now = Date.now()): void {
    const current = this.readOwnership(appId);
    if (!current || current.herdId !== herdId) return;
    writeFileSync(
      this.#ownershipPath(appId),
      `${JSON.stringify({ ...current, pid, updatedAt: now })}\n`,
      { mode: 0o666 },
    );
  }

  readOwnership(appId: string): SlackOwnership | null {
    return this.#readJson<SlackOwnership>(this.#ownershipPath(appId));
  }

  enqueueCommand(command: HerdCommand): void {
    const dir = path.join(this.#commandsDir(), sanitize(command.herdId));
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    const file = path.join(dir, `${sanitize(command.id)}.json`);
    writeFileSync(file, `${JSON.stringify(command)}\n`, { mode: 0o666 });
  }

  /** Pending commands for a satellite, oldest first. */
  listCommands(herdId: string): HerdCommand[] {
    const dir = path.join(this.#commandsDir(), sanitize(herdId));
    if (!existsSync(dir)) return [];
    const rows: HerdCommand[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const parsed = this.#readJson<HerdCommand>(path.join(dir, name));
      if (parsed) rows.push(parsed);
    }
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  completeCommand(command: HerdCommand, result: Omit<HerdCommandResult, "id">): void {
    const file = path.join(
      this.#commandsDir(),
      sanitize(command.herdId),
      `${sanitize(command.id)}.json`,
    );
    try {
      unlinkSync(file);
    } catch {
      // already claimed
    }
    const out = path.join(this.#resultsDir(), `${sanitize(command.id)}.json`);
    writeFileSync(out, `${JSON.stringify({ id: command.id, ...result })}\n`, { mode: 0o666 });
  }

  takeResult(commandId: string): HerdCommandResult | null {
    const file = path.join(this.#resultsDir(), `${sanitize(commandId)}.json`);
    const parsed = this.#readJson<HerdCommandResult>(file);
    if (!parsed) return null;
    try {
      unlinkSync(file);
    } catch {
      // keep going
    }
    return parsed;
  }

  #readJson<T>(file: string): T | null {
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]+/g, "_");
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
