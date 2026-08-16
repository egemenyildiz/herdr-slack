import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { rotateIfNeeded } from "../util/rotate.js";
import { logPath } from "./supervisor.js";

/** Rotate the daemon log past this size. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Keep this many rotations, then drop the oldest. */
export const KEEP_LOGS = 3;

export type LogLevel = "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  msg?: string;
  [field: string]: unknown;
}

/**
 * ndjson daemon log.
 *
 * One JSON object per line rather than prose, because this file is what people
 * paste into a setup-problem issue: fields survive the paste, sentences don't.
 * `daemon logs` renders it back to prose for humans and passes it through with
 * `--json`.
 *
 * ⚠️ 0600, always. Under `--dry-run` the rendered Slack payloads land here, so
 * the log can hold terminal output — and the reason this whole project turns on
 * is that terminal output carries secrets.
 */
export class Logger {
  readonly #file: string;

  constructor(
    instance: string,
    private readonly maxBytes = MAX_LOG_BYTES,
    file?: string,
  ) {
    this.#file = file ?? logPath(instance);
  }

  get file(): string {
    return this.#file;
  }

  /** A named event with structured fields — the preferred call. */
  event(event: string, fields: Record<string, unknown> = {}, level: LogLevel = "info"): void {
    this.#write({ ts: new Date().toISOString(), level, event, ...fields });
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.event(event, fields, "warn");
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.event(event, fields, "error");
  }

  /**
   * A free-form line from a component that logs prose.
   *
   * The surfaces take a `(line: string) => void` port and their tests assert on
   * substrings; wrapping rather than converting them keeps one format on disk
   * without a rewrite that buys nothing.
   */
  line(msg: string): void {
    this.event("surface", { msg });
  }

  #write(record: LogRecord): void {
    try {
      mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      rotateIfNeeded(this.#file, this.maxBytes, KEEP_LOGS);
      appendFileSync(this.#file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // A daemon that dies because it could not log is worse than a silent one.
    }
  }
}

/** Parse one stored line, or null if it is not a record we wrote. */
export function parseLine(line: string): LogRecord | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<LogRecord>;
    if (typeof record.ts !== "string" || typeof record.event !== "string") return null;
    return record as LogRecord;
  } catch {
    return null;
  }
}

/**
 * Render a stored line for a human.
 *
 * Lines that don't parse are passed through verbatim: logs written before this
 * format existed, and anything a crash wrote half of, still have to be readable.
 */
export function renderLine(line: string): string {
  const record = parseLine(line);
  if (!record) return line;

  const { ts, level, event, msg, ...rest } = record;
  const fields = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");

  const badge = level === "info" ? "" : `${level.toUpperCase()} `;
  const body = event === "surface" ? (msg ?? "") : [event, msg, fields].filter(Boolean).join(" ");
  return `${ts} ${badge}${body}`.trimEnd();
}
