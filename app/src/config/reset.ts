import { existsSync, rmSync, writeFileSync } from "node:fs";
import { currentPlatform, disableService, uninstallService, unitPath } from "../daemon/service.js";
import { readConfigFile } from "./config.js";
import { configPath, stateDir } from "./instance.js";
import { type SecretStore, detectSecretStore } from "./secrets.js";
import { clearSetupStatus } from "./setup-status.js";

export interface ResetResult {
  removed: string[];
  kept: string[];
}

export interface ResetOptions {
  instance: string;
  configFile?: string;
  secretStore?: SecretStore;
  uninstallServiceFn?: typeof uninstallService;
  disableServiceFn?: typeof disableService;
  /** Test-only: unitPath resolves under this instead of the real home dir. */
  home?: string;
}

/**
 * Remove everything this instance put on the machine.
 *
 * Setup writes to four places — config.json, the OS keychain, a state directory,
 * and a launchd/systemd unit — and forgetting any one of them leaves a "fresh"
 * install that is not fresh: stale credentials get reused, an old thread ts
 * makes the daemon update messages nobody can see. Doing it by hand means
 * remembering all four, so it is a command.
 *
 * What it cannot remove is the Slack app itself, which lives in the workspace,
 * not here — so it says so rather than implying a clean slate it did not make.
 */
/** Forget both tokens, reporting only the ones that were actually there. */
async function clearCredentials(store: SecretStore, instance: string): Promise<string[]> {
  if (store.kind !== "keychain") return [];
  const removed: string[] = [];
  for (const field of ["botToken", "appToken"] as const) {
    // remove() is idempotent and reports nothing, so check first — claiming to
    // have deleted a credential that was never there is its own kind of lie.
    const had = (await store.get(instance, field)) !== null;
    await store.remove(instance, field);
    if (had) removed.push(`keychain: ${instance}/${field}`);
  }
  return removed;
}

/** Drop one instance, keeping any others that share the file. */
function dropFromConfig(configFile: string, instance: string): string[] {
  if (!existsSync(configFile)) return [];
  const config = readConfigFile(configFile);
  if (!config.instances[instance]) return [];

  delete config.instances[instance];
  if (Object.keys(config.instances).length === 0) {
    rmSync(configFile, { force: true });
    return [configFile];
  }
  // Work and personal share this file — rewrite rather than delete, keeping
  // 0600, which the loader enforces on the way back in.
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return [`${configFile} (instance "${instance}" only)`];
}

export async function runReset(options: ResetOptions): Promise<ResetResult> {
  const { instance } = options;
  const configFile = options.configFile ?? configPath();
  const removed: string[] = [];
  const kept: string[] = [];

  const store = options.secretStore ?? (await detectSecretStore());
  removed.push(...(await clearCredentials(store, instance)));
  removed.push(...dropFromConfig(configFile, instance));
  // Drop the progress marker before wiping the state dir so a partial wipe
  // (state missing, config still there) cannot leave a stale "in_progress".
  clearSetupStatus(instance);

  const state = stateDir(instance);
  if (existsSync(state)) {
    rmSync(state, { recursive: true, force: true });
    removed.push(state);
  }

  // Unregister from launchd/systemd before deleting the unit file: deleting it
  // leaves the job loaded, pointing at a shim that no longer exists.
  const platform = currentPlatform();
  const unit = platform ? unitPath(instance, platform, options.home) : null;
  const hadUnit = unit !== null && existsSync(unit);
  const disabled = (options.disableServiceFn ?? disableService)(instance);
  if (disabled.ok) removed.push(`service: ${disabled.detail}`);
  (options.uninstallServiceFn ?? uninstallService)(instance, undefined, options.home);
  if (hadUnit && unit) removed.push(unit);

  kept.push("the Slack app itself — delete it at api.slack.com/apps if you want it gone");
  return { removed, kept };
}
