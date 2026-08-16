import { existsSync, renameSync, statSync } from "node:fs";

/**
 * Shift `file` to `file.1`, `file.1` to `file.2`, … dropping whatever falls off
 * the end, but only once `file` has grown past `maxBytes`.
 *
 * The daemon log is append-only and grows without bound, and it can hold
 * terminal output under `--dry-run`, so it cannot be left to fill a disk.
 * Returns whether a rotation happened.
 */
export function rotateIfNeeded(file: string, maxBytes: number, keep: number): boolean {
  if (!existsSync(file)) return false;
  if (statSync(file).size < maxBytes) return false;

  for (let i = keep; i >= 1; i -= 1) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    if (existsSync(from)) renameSync(from, to);
  }
  return true;
}
