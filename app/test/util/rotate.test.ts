import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rotateIfNeeded } from "../../src/util/rotate.js";

describe("rotateIfNeeded", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-rot-"));
    file = path.join(dir, "thing.log");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("does nothing to a file under the limit", () => {
    writeFileSync(file, "small");
    expect(rotateIfNeeded(file, 100, 3)).toBe(false);
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it("does nothing when the file does not exist", () => {
    expect(rotateIfNeeded(file, 1, 3)).toBe(false);
  });

  it("shifts the current file aside once it is over the limit", () => {
    writeFileSync(file, "x".repeat(200));
    expect(rotateIfNeeded(file, 100, 3)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(200));
  });

  it("shifts older rotations down and drops what falls off the end", () => {
    writeFileSync(`${file}.1`, "first");
    writeFileSync(`${file}.2`, "oldest");
    writeFileSync(file, "y".repeat(200));

    rotateIfNeeded(file, 100, 2);

    expect(readFileSync(`${file}.1`, "utf8")).toBe("y".repeat(200));
    expect(readFileSync(`${file}.2`, "utf8")).toBe("first");
    expect(existsSync(`${file}.3`)).toBe(false);
  });
});
