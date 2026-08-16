import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../config/instance.js";
import type { NewAgentDefaults } from "../slack/modals.js";

/**
 * The choices from the last launch, so the form comes back pre-filled.
 *
 * Launching a second agent is nearly always a variation on the last one — same
 * workspace, same directory, same kind — and re-picking all of it from a phone
 * each time is the friction that makes people not bother.
 *
 * Deliberately does *not* remember the first prompt or the tab label: those are
 * the parts that are genuinely different every time, and pre-filling them
 * invites launching something with last week's instructions by accident.
 */
export interface LastLaunch {
  workspaceId?: string;
  cwd?: string;
  typedCwd?: string;
  kind?: string;
}

function lastLaunchPath(instance: string): string {
  return path.join(stateDir(instance), "last-launch.json");
}

export function readLastLaunch(instance: string): NewAgentDefaults | undefined {
  const file = lastLaunchPath(instance);
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const str = (key: string): string | undefined =>
      typeof record[key] === "string" && record[key] ? (record[key] as string) : undefined;
    return {
      workspaceId: str("workspaceId"),
      cwd: str("cwd"),
      typedCwd: str("typedCwd"),
      kind: str("kind"),
    };
  } catch {
    return undefined;
  }
}

export function writeLastLaunch(instance: string, value: LastLaunch): void {
  try {
    const dir = stateDir(instance);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(lastLaunchPath(instance), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A convenience that cannot be saved is not a reason to fail a launch.
  }
}
