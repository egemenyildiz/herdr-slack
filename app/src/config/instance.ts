import os from "node:os";
import path from "node:path";

/**
 * Map a herdr socket path to an instance key.
 *
 * The `sess-` prefix is not cosmetic: mapping named sessions to their bare name
 * collides, because `herdr --session default` and the unnamed session would both
 * derive `default`. Setup would then overwrite the other's tokens and pinned
 * team_id — silently breaking the isolation guarantee for the one session name a
 * user is most likely to pick.
 */
export function instanceKeyForSocket(socketPath: string): string {
  const normalized = path.normalize(socketPath);
  const parts = normalized.split(path.sep);
  const index = parts.lastIndexOf("sessions");
  if (index >= 0 && parts.length > index + 1) {
    const name = parts[index + 1];
    if (name) return `sess-${sanitize(name)}`;
  }
  return "default";
}

/** Instance keys become file and unit names, so keep them boring. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Env var namespace for an instance: `HERDR_SLACK_<INSTANCE>_<FIELD>`. */
export function envPrefix(instance: string): string {
  return `HERDR_SLACK_${instance.replace(/-/g, "_").toUpperCase()}_`;
}

export const PLUGIN_ID = "herdr-slack";

/**
 * herdr's own convention for where a plugin's config/state live, mirrored here
 * so a bare CLI invocation resolves to the SAME path herdr injects via
 * HERDR_PLUGIN_CONFIG_DIR / HERDR_PLUGIN_STATE_DIR for startup hooks, panes,
 * and actions.
 *
 * This used to be a project-owned fallback (`~/.config/herdr-slack`) instead of
 * herdr's path, and the two diverged: a manual `node cli.js setup` run (no
 * herdr env) wrote there, while the setup popup — invoked BY herdr, which
 * always sets these vars — looked in herdr's own plugin directory and found
 * nothing. It concluded the instance was unconfigured and silently reran the
 * full wizard, creating a second Slack app in the same workspace. Matching
 * herdr's convention exactly means every caller agrees on one location whether
 * or not HERDR_PLUGIN_* happens to be set — see ADR 0009.
 */
function herdrPluginConfigDir(): string {
  return path.join(os.homedir(), ".config", "herdr", "plugins", "config", PLUGIN_ID);
}

function herdrPluginStateDir(): string {
  return path.join(os.homedir(), ".local", "state", "herdr", "plugins", PLUGIN_ID);
}

/**
 * Where per-instance runtime state lives.
 *
 * herdr injects HERDR_PLUGIN_STATE_DIR when it launches us (startup hook, pane,
 * action). The daemon runs under launchd/systemd, which has no herdr
 * environment, so the shim installed at setup time bakes in whatever this
 * resolved to at that moment (ADR 0002) — which is why the fallback below must
 * be stable and identical across every caller (ADR 0009).
 */
export function stateDir(instance: string): string {
  const base = process.env.HERDR_PLUGIN_STATE_DIR ?? herdrPluginStateDir();
  return path.join(base, instance);
}

/** Where config lives. Shared across instances; the file is keyed by instance. */
export function configDir(): string {
  return process.env.HERDR_PLUGIN_CONFIG_DIR ?? herdrPluginConfigDir();
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}
