import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "./instance.js";

/**
 * Extra environment variables the daemon needs to reach Slack over HTTPS.
 *
 * Only ever `NODE_EXTRA_CA_CERTS` today, but kept as a map rather than a single
 * field because the same problem shows up as `HTTPS_PROXY`/`SSL_CERT_FILE` on
 * other machines and the shape should not need to change again.
 */
export type NetworkEnv = Record<string, string>;

const CANDIDATE_ENV_VARS = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"] as const;
/** Standard CA bundle locations, checked only if nothing in the environment works. */
const CANDIDATE_PATHS = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"] as const;

export type Prober = (env: NodeJS.ProcessEnv) => boolean;

/**
 * Whether a bare Node process, given exactly this environment, can complete a
 * TLS handshake with Slack.
 *
 * Spawned rather than checked in-process: Node resolves its CA trust store
 * lazily on first use and (depending on version) may not re-resolve it if
 * `process.env` changes after that, so probing candidates one at a time in this
 * process would not reliably tell us what a **fresh** process — which is what
 * the daemon always is — would actually do.
 *
 * Uses `process.execPath` deliberately: whether an override is needed depends on
 * the interpreter, not just the machine. Two Node installs on the same Mac (a
 * Homebrew build and an nvm one) disagree about whether the system CA store is
 * usable, and the shim bakes in this same execPath — so the thing probed is the
 * thing that will run.
 */
export function probeHttps(env: NodeJS.ProcessEnv, timeoutMs = 5_000): boolean {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "require('https').get('https://slack.com/api/api.test',res=>{res.resume();process.exit(res.statusCode?0:1)}).on('error',()=>process.exit(1))",
    ],
    { env, timeout: timeoutMs },
  );
  return result.status === 0;
}

/**
 * Find an environment override that fixes outbound HTTPS, if one is needed.
 *
 * launchd and systemd start services with a minimal environment — not the
 * shell profile a human's `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` usually lives
 * in — so a daemon that works fine when run by hand from a terminal can fail
 * every single Slack API call once installed as a service. Node's TLS error in
 * that case (`unable to get local issuer certificate`) does not say why, and
 * Slack's side of it is just "the app did not respond" (dispatch_failed),
 * which is why this needs to be diagnosed here rather than left to surface
 * downstream as a support question.
 *
 * Probes a stripped environment first — most machines need nothing — then
 * tries whatever the caller's own environment or a few standard bundle paths
 * would add, keeping only the first candidate that actually fixes the probe.
 */
export type NetworkDiscovery =
  /** A stripped environment already works — nothing to bake into the shim. */
  | { kind: "ok" }
  /** A stripped environment fails, and this override fixes it. */
  | { kind: "fixed"; env: NetworkEnv }
  /** A stripped environment fails and nothing tried fixes it. */
  | { kind: "unreachable" };

/**
 * Find an environment override that fixes outbound HTTPS, if one is needed.
 *
 * launchd and systemd start services with a minimal environment — not the
 * shell profile a human's `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` usually lives
 * in — so a daemon that works fine when run by hand from a terminal can fail
 * every single Slack API call once installed as a service. Node's TLS error in
 * that case (`unable to get local issuer certificate`) does not say why, and
 * Slack's side of it is just "the app did not respond" (dispatch_failed),
 * which is why this needs to be diagnosed here rather than left to surface
 * downstream as a support question.
 *
 * The three-way result matters: `ok` and `unreachable` must never collapse
 * into the same "no override" shape, or a machine that cannot reach Slack at
 * all — the case someone most needs to hear about — reads as fine.
 */
export function discoverNetworkEnv(
  callerEnv: NodeJS.ProcessEnv = process.env,
  prober: Prober = probeHttps,
): NetworkDiscovery {
  const stripped: NodeJS.ProcessEnv = { PATH: callerEnv.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" };
  if (prober(stripped)) return { kind: "ok" };

  for (const key of CANDIDATE_ENV_VARS) {
    const value = callerEnv[key];
    if (value && prober({ ...stripped, [key]: value })) {
      return { kind: "fixed", env: { [key]: value } };
    }
  }
  for (const file of CANDIDATE_PATHS) {
    if (existsSync(file) && prober({ ...stripped, NODE_EXTRA_CA_CERTS: file })) {
      return { kind: "fixed", env: { NODE_EXTRA_CA_CERTS: file } };
    }
  }
  return { kind: "unreachable" };
}

function networkEnvPath(instance: string): string {
  return path.join(stateDir(instance), "network-env.json");
}

/** Persist what `discoverNetworkEnv` found, so every future launcher agrees. */
export function saveNetworkEnv(instance: string, env: NetworkEnv): void {
  const dir = stateDir(instance);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(networkEnvPath(instance), `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
}

export function clearNetworkEnv(instance: string): void {
  rmSync(networkEnvPath(instance), { force: true });
}

/**
 * Read back what setup found, for anyone spawning the daemon.
 *
 * Both launch paths need this independently: the shim (launchd/systemd) has it
 * baked in as literal `export` lines at install time, but `daemon ensure`'s
 * detached spawn runs through whatever ambient environment herdr's startup
 * hook happened to get, which is a second, separate place the override can be
 * missing.
 */
export function loadNetworkEnv(instance: string): NetworkEnv {
  const file = networkEnvPath(instance);
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}
