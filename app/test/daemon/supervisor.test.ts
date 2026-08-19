import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireLock,
  installProcessGuards,
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

describe("installProcessGuards", () => {
  const listeners = {
    rejection: [] as NodeJS.UnhandledRejectionListener[],
    exception: [] as NodeJS.UncaughtExceptionListener[],
  };

  beforeEach(() => {
    listeners.rejection = [];
    listeners.exception = [];
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      listener: (...args: never[]) => void,
    ) => {
      if (event === "unhandledRejection") {
        listeners.rejection.push(listener as NodeJS.UnhandledRejectionListener);
      }
      if (event === "uncaughtException") {
        listeners.exception.push(listener as NodeJS.UncaughtExceptionListener);
      }
      return process;
    }) as typeof process.on);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs an unhandled rejection and keeps the process alive", () => {
    const errors: { event: string; fields: Record<string, unknown> }[] = [];
    installProcessGuards({
      error(event, fields = {}) {
        errors.push({ event, fields });
      },
    });
    expect(listeners.rejection).toHaveLength(1);
    listeners.rejection[0]?.(undefined, Promise.resolve());
    listeners.rejection[0]?.(new Error("bolt frame"), Promise.resolve());
    expect(errors).toEqual([
      { event: "daemon.unhandled_rejection", fields: { message: "undefined" } },
      { event: "daemon.unhandled_rejection", fields: { message: "bolt frame" } },
    ]);
  });

  it("exits non-zero on an uncaught exception so KeepAlive restarts", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errors: { event: string; fields: Record<string, unknown> }[] = [];
    installProcessGuards({
      error(event, fields = {}) {
        errors.push({ event, fields });
      },
    });
    expect(listeners.exception).toHaveLength(1);
    listeners.exception[0]?.(new Error("sync boom"), "uncaughtException");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.event).toBe("daemon.uncaught_exception");
    expect(errors[0]?.fields.message).toBe("sync boom");
    expect(errors[0]?.fields.name).toBe("Error");
    expect(typeof errors[0]?.fields.stack).toBe("string");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
