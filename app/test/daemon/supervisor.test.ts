import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  isRunning,
  logPath,
  readRecord,
  recordPath,
  writeRecord,
} from "../../src/daemon/supervisor.js";

describe("daemon supervisor", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-daemon-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("grants the lock to exactly one holder", async () => {
    const first = await acquireLock("default");
    expect(first).not.toBeNull();

    // The second caller must lose quietly — that is what makes concurrent
    // `ensure` invocations benign rather than racy.
    const second = await acquireLock("default");
    expect(second).toBeNull();

    await first?.();
  });

  it("lets a new holder take over after the first releases", async () => {
    const first = await acquireLock("default");
    await first?.();

    const second = await acquireLock("default");
    expect(second).not.toBeNull();
    await second?.();
  });

  it("isolates instances so work and personal never block each other", async () => {
    const a = await acquireLock("default");
    const b = await acquireLock("sess-work");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a?.();
    await b?.();
  });

  it("reports whether a daemon is running", async () => {
    expect(await isRunning("default")).toBe(false);
    const release = await acquireLock("default");
    expect(await isRunning("default")).toBe(true);
    await release?.();
    expect(await isRunning("default")).toBe(false);
  });

  it("round-trips the daemon record", () => {
    writeRecord({
      pid: 4242,
      instance: "default",
      socketPath: "/tmp/h.sock",
      startedAt: "2026-08-13T00:00:00Z",
      version: "0.1.0",
    });
    expect(readRecord("default")).toMatchObject({ pid: 4242, instance: "default" });
  });

  it("treats a corrupt record as absent rather than crashing the daemon", () => {
    writeRecord({
      pid: 1,
      instance: "default",
      socketPath: "/tmp/h.sock",
      startedAt: "now",
      version: "0.1.0",
    });
    writeFileSync(recordPath("default"), "{ not json");
    expect(readRecord("default")).toBeNull();
  });

  it("has no record before the daemon has ever run", () => {
    expect(readRecord("never-started")).toBeNull();
  });

  it("keeps state per instance", () => {
    expect(logPath("default")).toContain(path.join(dir, "default"));
    expect(logPath("sess-work")).toContain(path.join(dir, "sess-work"));
  });
});
