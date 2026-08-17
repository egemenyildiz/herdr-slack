/**
 * Authentication for the shared herd registry.
 *
 * A cross-account registry directory has to be writable by every daemon that
 * uses it, which means it is also writable by anything else running as those
 * users. Registry writes are not inert: a `prompt` command is typed into a
 * terminal by whichever daemon picks it up. Unauthenticated records would make
 * "can create a file in this directory" equivalent to "can type into your
 * terminal", so every record carries an HMAC and unverifiable records are
 * dropped on read.
 *
 * The key is derived from the Slack bot token. Daemons that share a Slack app
 * already share that token, and anything without it is not one of them.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const KEY_DOMAIN = "herdr-slack/herd-registry/v1";

export const ENVELOPE_VERSION = 1;

export interface Sealed<T> {
  v: number;
  sig: string;
  record: T;
}

/** Derive the registry key. Never write the token itself anywhere. */
export function registryKey(botToken: string): Buffer {
  return createHash("sha256").update(`${KEY_DOMAIN}:${botToken}`).digest();
}

/**
 * Stable serialisation for signing.
 *
 * `JSON.stringify` preserves insertion order, so two daemons building the same
 * record with fields in a different order would disagree on the signature.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function signature(key: Buffer, record: unknown): string {
  return createHmac("sha256", key).update(canonicalJson(record)).digest("hex");
}

export function seal<T>(key: Buffer, record: T): Sealed<T> {
  return { v: ENVELOPE_VERSION, sig: signature(key, record), record };
}

/**
 * Verify and unwrap a record read off disk.
 *
 * Returns null for anything that is not a correctly signed envelope of this
 * version — malformed, unsigned, tampered with, or written by something that
 * does not hold the key. Callers treat null as "this record does not exist".
 */
export function unseal<T>(key: Buffer, envelope: unknown): T | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const candidate = envelope as { v?: unknown; sig?: unknown; record?: unknown };
  if (candidate.v !== ENVELOPE_VERSION) return null;
  if (typeof candidate.sig !== "string" || candidate.sig.length === 0) return null;
  if (typeof candidate.record !== "object" || candidate.record === null) return null;

  const expected = Buffer.from(signature(key, candidate.record), "hex");
  const actual = Buffer.from(candidate.sig, "hex");
  // timingSafeEqual throws on a length mismatch, which a forged sig can cause.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;
  return candidate.record as T;
}
