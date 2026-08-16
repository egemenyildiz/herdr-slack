import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateDir } from "../../src/config/instance.js";
import { Logger, parseLine, renderLine } from "../../src/daemon/logger.js";
import { redirectStateToScratch } from "../../src/daemon/run.js";
import { logPath } from "../../src/daemon/supervisor.js";

describe("Logger", () => {
  let dir: string;
  let log: Logger;

  const lines = () =>
    readFileSync(logPath("default"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-log-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    log = new Logger("default");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("writes one JSON object per line", () => {
    log.event("daemon.up", { pid: 42 });
    const record = JSON.parse(lines()[0] ?? "");
    expect(record).toMatchObject({ level: "info", event: "daemon.up", pid: 42 });
    expect(Date.parse(record.ts)).not.toBeNaN();
  });

  it("writes the log 0600", () => {
    // Under --dry-run this file can hold rendered Slack payloads, so it gets
    // secret-file permissions.
    log.event("anything");
    expect(statSync(logPath("default")).mode & 0o777).toBe(0o600);
  });

  it("records levels", () => {
    log.warn("slack.slow", { ms: 900 });
    log.error("slack.connect_failed", { message: "invalid_auth" });
    const [warn, error] = lines().map((line) => JSON.parse(line));
    expect(warn.level).toBe("warn");
    expect(error.level).toBe("error");
  });

  it("wraps free-form component lines", () => {
    log.line("denied unknown_ref");
    expect(JSON.parse(lines()[0] ?? "")).toMatchObject({
      event: "surface",
      msg: "denied unknown_ref",
    });
  });

  it("rotates once past the limit", () => {
    const small = new Logger("default", 512);
    for (let i = 0; i < 40; i += 1) small.event("noise", { i, pad: "x".repeat(40) });

    expect(existsSync(`${logPath("default")}.1`)).toBe(true);
    expect(statSync(logPath("default")).size).toBeLessThan(2_000);
  });

  it("keeps the daemon alive when the log cannot be written", () => {
    // A daemon that dies because it could not log is worse than a silent one.
    const broken = new Logger("default", 5_000, path.join(dir, "nope", "\0bad"));
    expect(() => broken.event("still.fine")).not.toThrow();
  });
});

describe("parseLine", () => {
  it("rejects anything that is not one of our records", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("plain prose from an older daemon")).toBeNull();
    expect(parseLine('{"ts":"now"}')).toBeNull();
    expect(parseLine("null")).toBeNull();
    expect(parseLine('"a string"')).toBeNull();
  });

  it("accepts a record it wrote", () => {
    expect(parseLine('{"ts":"t","level":"info","event":"e"}')?.event).toBe("e");
  });
});

describe("renderLine", () => {
  it("renders fields as key=value", () => {
    const out = renderLine(
      '{"ts":"2026-01-01T00:00:00.000Z","level":"info","event":"daemon.up","pid":7}',
    );
    expect(out).toContain("daemon.up");
    expect(out).toContain("pid=7");
  });

  it("unwraps surface lines back to prose", () => {
    const out = renderLine(
      '{"ts":"2026-01-01T00:00:00.000Z","level":"info","event":"surface","msg":"hello"}',
    );
    expect(out).toBe("2026-01-01T00:00:00.000Z hello");
  });

  it("badges anything above info", () => {
    expect(renderLine('{"ts":"t","level":"error","event":"boom"}')).toContain("ERROR");
    expect(renderLine('{"ts":"t","level":"info","event":"fine"}')).not.toContain("INFO");
  });

  it("passes through what it cannot parse", () => {
    // Logs written before this format existed still have to be readable.
    expect(renderLine("2026-01-01 daemon up")).toBe("2026-01-01 daemon up");
  });
});

describe("dry-run state scoping", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-dry-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("moves state aside but leaves the log where it was", () => {
    // A dry run still runs the whole daemon, and the daemon persists. Without
    // this, the transport's synthetic `dry-ts-N` would land in sessions.json as
    // a real thread ts, and the real daemon would chat.update forever against a
    // timestamp Slack has never heard of.
    const before = new Logger("default");
    const scratch = redirectStateToScratch();

    expect(stateDir("default").startsWith(scratch)).toBe(true);
    expect(before.file.startsWith(dir)).toBe(true);

    before.event("still.the.real.log");
    expect(readFileSync(before.file, "utf8")).toContain("still.the.real.log");
    rmSync(scratch, { recursive: true, force: true });
  });
});
