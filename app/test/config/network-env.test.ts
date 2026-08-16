import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearNetworkEnv,
  discoverNetworkEnv,
  loadNetworkEnv,
  saveNetworkEnv,
} from "../../src/config/network-env.js";

describe("discoverNetworkEnv", () => {
  it("reports ok when a bare environment already works", () => {
    const result = discoverNetworkEnv({ PATH: "/usr/bin" }, () => true);
    expect(result).toEqual({ kind: "ok" });
  });

  it("adopts NODE_EXTRA_CA_CERTS from the caller when that is what fixes it", () => {
    // This is this machine's actual failure mode: launchd strips the shell
    // profile that sets this, and the stripped probe fails until it is added.
    const prober = (env: NodeJS.ProcessEnv) => Boolean(env.NODE_EXTRA_CA_CERTS);
    const result = discoverNetworkEnv(
      { PATH: "/usr/bin", NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" },
      prober,
    );
    expect(result).toEqual({ kind: "fixed", env: { NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" } });
  });

  it("falls back to SSL_CERT_FILE when NODE_EXTRA_CA_CERTS does not fix it", () => {
    const prober = (env: NodeJS.ProcessEnv) => Boolean(env.SSL_CERT_FILE);
    const result = discoverNetworkEnv(
      { PATH: "/usr/bin", NODE_EXTRA_CA_CERTS: "/wrong", SSL_CERT_FILE: "/right" },
      prober,
    );
    expect(result).toEqual({ kind: "fixed", env: { SSL_CERT_FILE: "/right" } });
  });

  it("tries standard bundle paths only when they exist on disk", () => {
    // /etc/ssl/cert.pem genuinely exists on macOS; treat it as the signal that
    // the "no env var, but a standard bundle fixes it" branch is reachable.
    if (!existsSync("/etc/ssl/cert.pem")) return;
    const prober = (env: NodeJS.ProcessEnv) => env.NODE_EXTRA_CA_CERTS === "/etc/ssl/cert.pem";
    const result = discoverNetworkEnv({ PATH: "/usr/bin" }, prober);
    expect(result).toEqual({ kind: "fixed", env: { NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" } });
  });

  it("reports unreachable when nothing tried fixes it, rather than looking like ok", () => {
    // ok and unreachable must never collapse to the same shape: this is the
    // case someone most needs a loud signal for, not a silent "nothing to do".
    const result = discoverNetworkEnv({ PATH: "/usr/bin" }, () => false);
    expect(result).toEqual({ kind: "unreachable" });
  });
});

describe("network env persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-netenv-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("round-trips through save and load", () => {
    saveNetworkEnv("default", { NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" });
    expect(loadNetworkEnv("default")).toEqual({ NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem" });
  });

  it("returns empty when nothing was ever saved", () => {
    expect(loadNetworkEnv("default")).toEqual({});
  });

  it("is keyed per instance", () => {
    saveNetworkEnv("default", { NODE_EXTRA_CA_CERTS: "/a" });
    saveNetworkEnv("sess-work", { NODE_EXTRA_CA_CERTS: "/b" });
    expect(loadNetworkEnv("default")).toEqual({ NODE_EXTRA_CA_CERTS: "/a" });
    expect(loadNetworkEnv("sess-work")).toEqual({ NODE_EXTRA_CA_CERTS: "/b" });
  });

  it("clears cleanly, and clearing twice is not an error", () => {
    saveNetworkEnv("default", { NODE_EXTRA_CA_CERTS: "/a" });
    clearNetworkEnv("default");
    expect(loadNetworkEnv("default")).toEqual({});
    expect(() => clearNetworkEnv("default")).not.toThrow();
  });

  it("ignores a corrupt file rather than throwing", () => {
    saveNetworkEnv("default", { NODE_EXTRA_CA_CERTS: "/a" });
    const file = path.join(dir, "default", "network-env.json");
    writeFileSync(file, "not json");
    expect(loadNetworkEnv("default")).toEqual({});
  });

  it("ignores a well-formed file that is not a flat string map", () => {
    const file = path.join(dir, "default", "network-env.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(["not", "an", "object"]));
    expect(loadNetworkEnv("default")).toEqual({});
  });

  it("drops non-string values instead of passing them through as env vars", () => {
    const file = path.join(dir, "default", "network-env.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ NODE_EXTRA_CA_CERTS: "/ok", BOGUS: 5 }));
    expect(loadNetworkEnv("default")).toEqual({ NODE_EXTRA_CA_CERTS: "/ok" });
  });
});
