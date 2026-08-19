import { existsSync, statSync } from "node:fs";
import { serviceLabel, serviceStatus } from "../daemon/service.js";
import { isRunning, readRecord } from "../daemon/supervisor.js";
import { HerdrClient } from "../herdr/client.js";
import { type SlackApiError, authTest, installUrl, verifyAppToken } from "../slack/api.js";
import { REQUIRED_PROTOCOL, isSupportedProtocol } from "../version.js";
import {
  type Config,
  type ConfigError,
  type InstanceConfig,
  readConfigFile,
  resolveInstance,
  validateInstance,
  withCredentials,
} from "./config.js";
import { configPath } from "./instance.js";
import { command, tildify } from "./invocation.js";
import { type Prober, discoverNetworkEnv, loadNetworkEnv, probeHttps } from "./network-env.js";
import { type SecretStore, detectSecretStore } from "./secrets.js";

export type CheckState = "pass" | "fail" | "warn";

export interface CheckResult {
  name: string;
  state: CheckState;
  detail: string;
  /** A command or URL the user can act on. */
  fix?: string;
}

export interface DoctorReport {
  instance: string;
  ok: boolean;
  checks: CheckResult[];
}

const pass = (name: string, detail: string): CheckResult => ({ name, state: "pass", detail });
const fail = (name: string, detail: string, fix?: string): CheckResult => ({
  name,
  state: "fail",
  detail,
  ...(fix === undefined ? {} : { fix }),
});
const warn = (name: string, detail: string, fix?: string): CheckResult => ({
  name,
  state: "warn",
  detail,
  ...(fix === undefined ? {} : { fix }),
});

export interface DoctorOptions {
  instance: string;
  configFile?: string;
  fetchImpl?: typeof fetch;
  secretStore?: SecretStore;
  /** Skip network calls — used by tests and by --offline. */
  offline?: boolean;
  /** Test-only: service/network checks resolve paths under this instead of the real home dir. */
  home?: string;
  /** Test-only: replaces the real HTTPS probe used by the background-network check. */
  networkProbe?: Prober;
}

/**
 * Run every check, in order, without stopping at the first failure.
 *
 * Stopping early is the wrong shape for a setup diagnostic: a user with three
 * problems would need three round trips to learn about them. `--json` emits the
 * same structure so the setup-problem issue form can carry it.
 */
/**
 * Each check is its own function returning results, so runDoctor stays a
 * readable list of steps rather than one long branch. They are also individually
 * testable, which matters because these are the messages a stuck user reads.
 */

function checkConfigValues(resolved: InstanceConfig): CheckResult[] {
  return validateInstance(resolved).map((problem) =>
    fail(
      "config values",
      problem,
      problem.includes("allowedUsers")
        ? `${command("setup --reconfigure")}  (an empty allowlist means anyone who can DM the bot gets a shell)`
        : command("setup --reconfigure"),
    ),
  );
}

async function checkHerdr(socket: string): Promise<CheckResult[]> {
  if (!socket || !existsSync(socket)) {
    return [
      fail("herdr socket", `${socket || "(unset)"} does not exist`, "start herdr, or re-run setup"),
    ];
  }
  if (!statSync(socket).isSocket()) {
    return [fail("herdr socket", `${socket} is not a socket`)];
  }

  const client = new HerdrClient(socket, 2_000);
  if (!(await client.ping())) {
    // Not fatal: the daemon outlives herdr by design (ADR 0002).
    return [warn("herdr", `not answering at ${socket}`, "start herdr with: herdr")];
  }

  const checks = [pass("herdr", `reachable at ${tildify(socket)}`)];
  try {
    const snapshot = await client.snapshot();
    checks.push(
      isSupportedProtocol(snapshot.protocol)
        ? pass("herdr protocol", `${snapshot.protocol} (herdr ${snapshot.version})`)
        : fail(
            "herdr protocol",
            `server speaks ${snapshot.protocol}, this build needs >= ${REQUIRED_PROTOCOL}`,
            "herdr update",
          ),
    );
  } catch {
    checks.push(warn("herdr protocol", "could not read a snapshot"));
  }
  return checks;
}

async function checkSlack(
  resolved: InstanceConfig,
  fetchImpl?: typeof fetch,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const { botToken, appToken, teamId, appId } = resolved.slack;

  try {
    const auth = await authTest(botToken, fetchImpl);
    checks.push(
      auth.team_id && teamId && auth.team_id !== teamId
        ? fail(
            "slack team",
            `token belongs to ${auth.team_id}, config is pinned to ${teamId}`,
            "you pasted a token from a different workspace — re-run setup for this instance",
          )
        : pass("slack bot token", `${auth.team ?? "workspace"} as ${auth.user_id ?? "bot"}`),
    );
  } catch (error) {
    const e = error as SlackApiError;
    checks.push(
      fail(
        "slack bot token",
        e.slackError ?? e.message,
        e.missingScope
          ? `missing a scope — reinstall: ${installUrl(appId)}`
          : `re-run setup, or reinstall: ${installUrl(appId)}`,
      ),
    );
  }

  checks.push(
    (await verifyAppToken(appToken, fetchImpl))
      ? pass("slack app token", "opened a Socket Mode connection")
      : fail(
          "slack app token",
          "could not open a Socket Mode connection",
          "regenerate the app-level token with connections:write, then: herdr-slack setup --resume",
        ),
  );
  return checks;
}

/**
 * A daemon can be "running" while launchd knows nothing about it: herdr's own
 * `daemon ensure` startup hook is a fallback for people who skip the service,
 * and it wins the lock race whenever it starts before (or instead of) the
 * launchd job. That process has zero crash recovery — seen live running
 * unsupervised for days before a crash finally took it down with nothing to
 * bring it back. Loaded-but-a-different-pid is the tell.
 */
async function checkDaemon(instance: string, home?: string): Promise<CheckResult> {
  const record = readRecord(instance);
  if (!(await isRunning(instance))) {
    return warn("daemon", "not running", command(`daemon start --instance ${instance}`));
  }
  const service = serviceStatus(instance, undefined, home);
  if (service.installed && service.loaded && record?.pid && service.runningPid !== record.pid) {
    return warn(
      "daemon",
      `running (pid ${record.pid}) but NOT the service-managed process — it will not restart itself if it crashes`,
      `launchctl kickstart -k gui/$(id -u)/${serviceLabel(instance)}`,
    );
  }
  return pass("daemon", `running${record?.pid ? ` (pid ${record.pid})` : ""}`);
}

/**
 * Would the background service actually be able to reach Slack?
 *
 * launchd/systemd run the daemon with a near-empty environment, so a machine
 * that needs NODE_EXTRA_CA_CERTS (or similar) in the shell profile can pass
 * every other check here — run from an interactive terminal — and still fail
 * silently once installed as a service, surfacing only as Slack telling
 * someone "the app did not respond" (ADR 0009). Skipped when there is no
 * service to fail this way, and offline-skippable like the Slack checks.
 */
function checkNetwork(instance: string, home?: string, prober: Prober = probeHttps): CheckResult {
  const service = serviceStatus(instance, undefined, home);
  if (!service.installed) return pass("background network", "no service installed — skipped");

  const discovered = discoverNetworkEnv(process.env, prober);
  if (discovered.kind === "ok") {
    return pass("background network", "reachable with no override needed");
  }
  if (discovered.kind === "unreachable") {
    return fail(
      "background network",
      "no environment override lets the service reach Slack in the background",
      `set NODE_EXTRA_CA_CERTS (or similar), then ${command("setup --reconfigure")}`,
    );
  }

  const saved = loadNetworkEnv(instance);
  const stillWorks = prober({ PATH: process.env.PATH, ...saved });
  return stillWorks
    ? pass("background network", `using ${Object.keys(saved).join(", ") || "a saved override"}`)
    : fail(
        "background network",
        "the service will not be able to reach Slack in the background",
        command("setup --reconfigure"),
      );
}

function checkService(instance: string, home?: string): CheckResult {
  const service = serviceStatus(instance, undefined, home);
  if (!service.installed) {
    return warn(
      "service",
      "not installed — the daemon will not survive a reboot",
      command("setup --reconfigure"),
    );
  }
  if (!service.targetOk) {
    // The exact failure a plugin upgrade causes: unit loaded, target moved.
    return fail(
      "service",
      `unit at ${tildify(service.unit)} points at a target that no longer exists`,
      command("setup --reconfigure"),
    );
  }
  return service.loaded
    ? pass("service", `installed and loaded (${tildify(service.unit)})`)
    : warn("service", "installed but not loaded", "see the setup output for the enable command");
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const {
    instance,
    configFile = configPath(),
    fetchImpl,
    offline = false,
    home,
    networkProbe,
  } = options;
  const checks: CheckResult[] = [];

  let config: Config;
  try {
    config = readConfigFile(configFile);
    checks.push(pass("config", `${tildify(configFile)} readable and 0600`));
  } catch (error) {
    const e = error as ConfigError;
    return { instance, ok: false, checks: [...checks, fail("config", e.message, e.fix)] };
  }

  let resolved: InstanceConfig;
  try {
    const store = options.secretStore ?? (await detectSecretStore());
    resolved = await withCredentials(instance, resolveInstance(config, instance), store);
    checks.push(pass("instance", `"${instance}" resolved`));
    checks.push(
      resolved.credentialStore === "keychain"
        ? pass("credentials", "stored in the OS keychain")
        : warn(
            "credentials",
            "stored in config.json (no keychain on this machine)",
            "the file is 0600; treat it as you would an ssh key",
          ),
    );
  } catch (error) {
    const e = error as ConfigError;
    return { instance, ok: false, checks: [...checks, fail("instance", e.message, e.fix)] };
  }

  checks.push(...checkConfigValues(resolved));
  checks.push(...(await checkHerdr(resolved.herdrSocketPath)));
  checks.push(
    ...(offline ? [warn("slack", "skipped (offline)")] : await checkSlack(resolved, fetchImpl)),
  );
  checks.push(await checkDaemon(instance, home));
  checks.push(checkService(instance, home));
  checks.push(
    offline
      ? warn("background network", "skipped (offline)")
      : checkNetwork(instance, home, networkProbe),
  );

  return { instance, ok: checks.every((check) => check.state !== "fail"), checks };
}

const ICON: Record<CheckState, string> = { pass: "✓", fail: "✗", warn: "!" };

export function formatReport(report: DoctorReport): string {
  const lines = [`herdr-slack doctor — instance "${report.instance}"`, ""];
  for (const check of report.checks) {
    lines.push(`  ${ICON[check.state]} ${check.name.padEnd(18)} ${check.detail}`);
  }
  const actionable = report.checks.filter((c) => c.state !== "pass" && c.fix);
  if (actionable.length > 0) {
    lines.push("", "To fix:");
    actionable.forEach((check, index) => {
      lines.push(`  ${index + 1}. ${check.name}: ${check.fix}`);
    });
  }
  lines.push("", report.ok ? "All required checks passed." : "Some checks failed.");
  return lines.join("\n");
}
