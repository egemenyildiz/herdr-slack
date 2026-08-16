import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, readConfigFile } from "./config.js";
import { configPath, stateDir } from "./instance.js";

/**
 * On-disk progress for an unfinished (or dismissed) setup.
 *
 * Config and credentials are written only on success, so without this marker a
 * `needs_admin` or abandoned pane leaves the next herdr session with nothing to
 * distinguish "never started" from "waiting on an admin" from "user said later".
 * ADR 0008.
 */
export type SetupStatusKind = "in_progress" | "needs_admin" | "dismissed";

export interface SetupStatus {
  status: SetupStatusKind;
  updatedAt: string;
}

export type SetupOfferKind = "configured" | "fresh" | "incomplete" | "dismissed";

function statusPath(instance: string): string {
  return path.join(stateDir(instance), "setup-status.json");
}

export function readSetupStatus(instance: string): SetupStatus | null {
  const file = statusPath(instance);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SetupStatus>;
    if (
      parsed.status !== "in_progress" &&
      parsed.status !== "needs_admin" &&
      parsed.status !== "dismissed"
    ) {
      return null;
    }
    if (typeof parsed.updatedAt !== "string") return null;
    return { status: parsed.status, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

export function writeSetupStatus(instance: string, status: SetupStatusKind): SetupStatus {
  const dir = stateDir(instance);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const value: SetupStatus = { status, updatedAt: new Date().toISOString() };
  writeFileSync(statusPath(instance), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return value;
}

export function clearSetupStatus(instance: string): void {
  const file = statusPath(instance);
  if (existsSync(file)) rmSync(file, { force: true });
}

/**
 * Whether this instance already has a config entry.
 *
 * Credentials are not checked here — `--offer` must stay fast and offline, and
 * a half-written config still means "do not auto-popup the fresh wizard".
 */
export function isConfigured(instance: string, configFile = configPath()): boolean {
  try {
    return readConfigFile(configFile).instances[instance] !== undefined;
  } catch (error) {
    if (error instanceof ConfigError) return false;
    throw error;
  }
}

/** What `--offer` / `--pane` should do for this instance. */
export function classifySetupOffer(instance: string, configFile = configPath()): SetupOfferKind {
  if (isConfigured(instance, configFile)) return "configured";
  const marker = readSetupStatus(instance);
  if (!marker) return "fresh";
  if (marker.status === "dismissed") return "dismissed";
  return "incomplete";
}
