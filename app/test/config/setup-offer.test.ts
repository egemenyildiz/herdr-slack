import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import { offerSetup, openResetPane, runSetupPane } from "../../src/config/setup-offer.js";
import {
  classifySetupOffer,
  readSetupStatus,
  writeSetupStatus,
} from "../../src/config/setup-status.js";
import type { SetupIo, SetupOutcome } from "../../src/config/setup.js";

function fakeIo(askAnswers: string[] = []): SetupIo & { printed: string[] } {
  const printed: string[] = [];
  let i = 0;
  return {
    printed,
    print: (text) => printed.push(text),
    ask: async (_q, fallback = "") => askAnswers[i++] ?? fallback,
    confirm: async (_q, fallbackYes) => fallbackYes,
    openBrowser: async () => undefined,
    copyToClipboard: async () => true,
    askSecret: async () => "",
  };
}

describe("offerSetup", () => {
  let dir: string;
  let configFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-offer-"));
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
    configFile = path.join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("no-ops when already configured", () => {
    writeFileSync(
      configFile,
      `${JSON.stringify({ version: 1, instances: { default: defaultInstance() } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const openPane = vi.fn();
    const result = offerSetup({ instance: "default", configFile, openPane });
    expect(result.reason).toBe("configured");
    expect(openPane).not.toHaveBeenCalled();
  });

  it("no-ops when the offer was dismissed", () => {
    writeSetupStatus("default", "dismissed");
    const openPane = vi.fn();
    const result = offerSetup({ instance: "default", configFile, openPane });
    expect(result.reason).toBe("dismissed");
    expect(openPane).not.toHaveBeenCalled();
  });

  it("opens the pane for a fresh install", () => {
    const openPane = vi.fn().mockReturnValue({ ok: true, detail: "opened" });
    const result = offerSetup({ instance: "default", configFile, openPane });
    expect(result).toEqual({ opened: true, reason: "opened", detail: "opened" });
    expect(openPane).toHaveBeenCalledWith("default");
  });

  it("opens the pane when setup was left incomplete", () => {
    writeSetupStatus("default", "needs_admin");
    const openPane = vi.fn().mockReturnValue({ ok: true, detail: "opened" });
    expect(offerSetup({ instance: "default", configFile, openPane }).opened).toBe(true);
  });

  it("force-opens after dismiss and clears the marker", () => {
    writeSetupStatus("default", "dismissed");
    const openPane = vi.fn().mockReturnValue({ ok: true, detail: "opened" });
    const result = offerSetup({ instance: "default", configFile, openPane, force: true });
    expect(result.opened).toBe(true);
    expect(readSetupStatus("default")).toBeNull();
  });

  it("reports open failure without throwing", () => {
    const openPane = vi.fn().mockReturnValue({ ok: false, detail: "ui_busy" });
    const result = offerSetup({ instance: "default", configFile, openPane });
    expect(result).toEqual({ opened: false, reason: "open_failed", detail: "ui_busy" });
  });
});

describe("openResetPane", () => {
  it("opens the reset manifest entrypoint", () => {
    expect(openResetPane("true")).toEqual({ ok: true, detail: "opened reset pane" });
  });

  it("reports when herdr cannot be started", () => {
    const result = openResetPane("/definitely/missing/herdr");
    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
  });
});

describe("runSetupPane", () => {
  let dir: string;
  let configFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-pane-"));
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
    configFile = path.join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("runs a fresh wizard when nothing is in progress", async () => {
    const io = fakeIo();
    const runSetupFn = vi.fn(
      async (): Promise<SetupOutcome> => ({
        status: "complete",
        instance: "default",
        message: "done",
      }),
    );
    const outcome = await runSetupPane({
      io,
      entrypoint: "/cli.js",
      configFile,
      socketPath: "/tmp/herdr.sock",
      runSetupFn,
    });
    expect(outcome.status).toBe("complete");
    expect(runSetupFn).toHaveBeenCalledWith(expect.objectContaining({ mode: "fresh" }));
  });

  it("offers continue / reset / dismiss when incomplete", async () => {
    writeSetupStatus("default", "in_progress");
    const io = fakeIo(["1"]);
    const runSetupFn = vi.fn(
      async (): Promise<SetupOutcome> => ({
        status: "complete",
        instance: "default",
        message: "done",
      }),
    );
    const relaunch = vi.fn().mockReturnValue({ ok: true, detail: "opened" });
    const outcome = await runSetupPane({
      io,
      entrypoint: "/cli.js",
      configFile,
      socketPath: "/tmp/herdr.sock",
      runSetupFn,
      relaunch,
    });
    expect(io.printed.join("")).toContain("not finished");
    // in_progress (not needs_admin) continues as fresh so create-app still runs
    expect(relaunch).toHaveBeenCalledWith("fresh");
    expect(runSetupFn).not.toHaveBeenCalled();
    expect(outcome.message).toContain("fresh setup pane");
  });

  it("resumes after needs_admin without recreating the Slack app", async () => {
    writeSetupStatus("default", "needs_admin");
    const io = fakeIo(["1"]);
    const runSetupFn = vi.fn();
    const relaunch = vi.fn().mockReturnValue({ ok: true, detail: "opened" });
    await runSetupPane({
      io,
      entrypoint: "/cli.js",
      configFile,
      socketPath: "/tmp/herdr.sock",
      runSetupFn,
      relaunch,
    });
    expect(relaunch).toHaveBeenCalledWith("resume");
    expect(runSetupFn).not.toHaveBeenCalled();
  });

  it("resets then opens a fresh pane when asked", async () => {
    writeSetupStatus("default", "needs_admin");
    const io = fakeIo(["2"]);
    const runResetFn = vi.fn(async () => ({ removed: [], kept: [] }));
    const runSetupFn = vi.fn();
    const relaunch = vi.fn().mockReturnValue({ ok: true, detail: "opened" });
    await runSetupPane({
      io,
      entrypoint: "/cli.js",
      configFile,
      socketPath: "/tmp/herdr.sock",
      runSetupFn,
      runResetFn,
      relaunch,
    });
    expect(runResetFn).toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledWith("fresh");
    expect(runSetupFn).not.toHaveBeenCalled();
  });

  it("clears this screen and runs in place when relaunch fails", async () => {
    writeSetupStatus("default", "in_progress");
    const io = fakeIo(["1"]);
    const runSetupFn = vi.fn(
      async (): Promise<SetupOutcome> => ({
        status: "complete",
        instance: "default",
        message: "done",
      }),
    );
    await runSetupPane({
      io,
      entrypoint: "/cli.js",
      configFile,
      socketPath: "/tmp/herdr.sock",
      runSetupFn,
      relaunch: () => ({ ok: false, detail: "ui_busy" }),
    });
    expect(io.printed.join("")).toContain("\x1b[2J");
    expect(runSetupFn).toHaveBeenCalledWith(expect.objectContaining({ mode: "fresh" }));
  });

  it("honours a forced mode from a refreshed pane without showing the menu", async () => {
    writeSetupStatus("default", "needs_admin");
    const io = fakeIo();
    const runSetupFn = vi.fn(
      async (): Promise<SetupOutcome> => ({
        status: "complete",
        instance: "default",
        message: "done",
      }),
    );
    await runSetupPane({
      io,
      entrypoint: "/cli.js",
      configFile,
      socketPath: "/tmp/herdr.sock",
      runSetupFn,
      forcedMode: "resume",
    });
    expect(io.printed.join("")).not.toContain("not finished");
    expect(runSetupFn).toHaveBeenCalledWith(expect.objectContaining({ mode: "resume" }));
  });

  it("dismisses without running the wizard", async () => {
    writeSetupStatus("default", "in_progress");
    const io = fakeIo(["3"]);
    const runSetupFn = vi.fn();
    const outcome = await runSetupPane({
      io,
      entrypoint: "/cli.js",
      configFile,
      socketPath: "/tmp/herdr.sock",
      runSetupFn,
    });
    expect(outcome.status).toBe("abandoned");
    expect(runSetupFn).not.toHaveBeenCalled();
    expect(classifySetupOffer("default", configFile)).toBe("dismissed");
  });

  it("refuses when already configured", async () => {
    writeFileSync(
      configFile,
      `${JSON.stringify({ version: 1, instances: { default: defaultInstance() } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const io = fakeIo();
    const outcome = await runSetupPane({
      io,
      entrypoint: "/cli.js",
      configFile,
      socketPath: "/tmp/herdr.sock",
      runSetupFn: vi.fn(),
    });
    expect(outcome.message).toContain("already set up");
  });
});
