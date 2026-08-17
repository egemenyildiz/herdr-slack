/**
 * Machine-wide discovery, so two accounts cannot silently run two primaries.
 *
 * `herdRegistryDir` used to be the only way for daemons under different OS
 * users to find each other, and nothing could set it: `setup` never wrote it
 * and `reset` deleted the whole instance section, so every reinstall split the
 * herds again and both elected themselves primary. Home then flapped between
 * two publishers with no indication why.
 *
 * Each daemon now drops a tiny pointer at a fixed path every OS user can reach.
 * Seeing a pointer from another herd on the same Slack app is enough to know a
 * shared registry is needed; the daemon moves to one and stays there.
 *
 * Two deliberate limits on what this trusts:
 *
 * - Pointers are **signed** like registry records. The directory is writable by
 *   any local account, and an unsigned pointer would be an invitation to
 *   redirect someone else's daemon.
 * - A pointer never names where to migrate *to*. The destination is a constant,
 *   so even a pointer we wrongly accepted cannot aim us at a directory the
 *   author controls. It only ever answers "is anyone else here?".
 *
 * The pointer itself is world-readable, so it carries hashes rather than the
 * app id and registry path — enough to compare, nothing worth reading.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { seal, unseal } from "./herd-signing.js";

/** A pointer older than this is from a daemon that is long gone. */
export const PEER_STALE_MS = 300_000;

const DIR_MODE = 0o777;
const FILE_MODE = 0o666;

export interface PeerPointer {
  herdId: string;
  /** sha256 of the Slack app id — enough to match, not to read. */
  appIdHash: string;
  /** sha256 of the registry directory this daemon is actually using. */
  registryDirHash: string;
  updatedAt: number;
  pid: number;
}

/** Where every OS user on this machine can read and write. */
export function machineSharedRoot(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "/Users/Shared/herdr-slack" : "/var/tmp/herdr-slack";
}

/**
 * The one registry every herd converges on.
 *
 * A constant on purpose — see the note above about never following a path out
 * of a pointer.
 */
export function sharedRegistryDir(platform: NodeJS.Platform = process.platform): string {
  return path.join(machineSharedRoot(platform), "registry");
}

export function peersDir(platform: NodeJS.Platform = process.platform): string {
  return path.join(machineSharedRoot(platform), "peers");
}

export function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // Created by another account with workable modes, or not ours to chmod.
  }
}

/**
 * The pointers on this machine.
 *
 * Failures here are never fatal: discovery is an optimisation over explicit
 * config, and a locked-down `/Users/Shared` must not stop the daemon booting.
 */
export class PeerDirectory {
  constructor(
    private readonly key: Buffer,
    readonly dir: string = peersDir(),
  ) {}

  #file(herdId: string): string {
    return path.join(this.dir, `${hashId(herdId)}.json`);
  }

  /** Announce which registry we are on. Returns false if the machine says no. */
  publish(pointer: PeerPointer): boolean {
    try {
      ensureDir(this.dir);
      const file = this.#file(pointer.herdId);
      writeFileSync(file, `${JSON.stringify(seal(this.key, pointer))}\n`, { mode: FILE_MODE });
      try {
        chmodSync(file, FILE_MODE);
      } catch {
        // Someone else's file; the write above already landed.
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Fresh, verified pointers for this app, excluding our own herd. */
  peers(appIdHash: string, selfHerdId: string, now = Date.now()): PeerPointer[] {
    return this.#all(appIdHash, now).filter((pointer) => pointer.herdId !== selfHerdId);
  }

  /** Our own pointer from a previous run, if it is still readable. */
  self(appIdHash: string, selfHerdId: string, now = Date.now()): PeerPointer | null {
    return this.#all(appIdHash, now).find((pointer) => pointer.herdId === selfHerdId) ?? null;
  }

  #all(appIdHash: string, now: number): PeerPointer[] {
    if (!existsSync(this.dir)) return [];
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: PeerPointer[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let parsed: PeerPointer | null = null;
      try {
        parsed = unseal<PeerPointer>(
          this.key,
          JSON.parse(readFileSync(path.join(this.dir, name), "utf8")),
        );
      } catch {
        continue;
      }
      // Unverifiable: forged, corrupt, or from a daemon on another Slack app.
      if (!parsed) continue;
      if (parsed.appIdHash !== appIdHash) continue;
      if (now - parsed.updatedAt > PEER_STALE_MS) continue;
      out.push(parsed);
    }
    return out;
  }

  remove(herdId: string): void {
    try {
      unlinkSync(this.#file(herdId));
    } catch {
      // already gone, or another account's to delete
    }
  }
}

export interface RegistryChoice {
  dir: string;
  shared: boolean;
  /** Why, for the log — this decision is invisible otherwise. */
  reason: "configured" | "peer-detected" | "was-shared" | "alone";
}

/**
 * Pick the registry directory for this daemon.
 *
 * Sticky once shared: a peer that is merely asleep should not send us back to a
 * private directory it cannot read, only to split again when it wakes.
 */
export function resolveRegistryDir(input: {
  configured?: string | undefined;
  privateDefault: string;
  peers: PeerPointer[];
  self: PeerPointer | null;
  platform?: NodeJS.Platform;
}): RegistryChoice {
  if (input.configured !== undefined) {
    return { dir: input.configured, shared: true, reason: "configured" };
  }
  const shared = sharedRegistryDir(input.platform ?? process.platform);
  if (input.self?.registryDirHash === hashId(shared)) {
    return { dir: shared, shared: true, reason: "was-shared" };
  }
  if (input.peers.length > 0) {
    return { dir: shared, shared: true, reason: "peer-detected" };
  }
  // Alone on this machine: keep the private 0700 registry, so agent titles and
  // working directories are not readable by other local accounts.
  return { dir: input.privateDefault, shared: false, reason: "alone" };
}

/** Build this daemon's pointer. */
export function pointerFor(input: {
  herdId: string;
  appId: string;
  registryDir: string;
  now?: number;
}): PeerPointer {
  return {
    herdId: input.herdId,
    appIdHash: hashId(input.appId),
    registryDirHash: hashId(input.registryDir),
    updatedAt: input.now ?? Date.now(),
    pid: process.pid,
  };
}

/** Whether a peer is on a different registry than us — i.e. a live split. */
export function splitWith(peers: PeerPointer[], ourRegistryDir: string): PeerPointer[] {
  const ours = hashId(ourRegistryDir);
  return peers.filter((peer) => peer.registryDirHash !== ours);
}

export function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}
