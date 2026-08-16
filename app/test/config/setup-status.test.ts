import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import {
  classifySetupOffer,
  clearSetupStatus,
  isConfigured,
  readSetupStatus,
  writeSetupStatus,
} from "../../src/config/setup-status.js";

describe("setup-status", () => {
  let dir: string;
  let configFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-status-"));
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
    configFile = path.join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("round-trips a status marker", () => {
    writeSetupStatus("default", "needs_admin");
    expect(readSetupStatus("default")?.status).toBe("needs_admin");
    clearSetupStatus("default");
    expect(readSetupStatus("default")).toBeNull();
  });

  it("ignores a corrupt marker rather than throwing", () => {
    const state = process.env.HERDR_PLUGIN_STATE_DIR ?? "";
    const file = path.join(state, "default");
    mkdirSync(file, { recursive: true });
    writeFileSync(path.join(file, "setup-status.json"), "{not json");
    expect(readSetupStatus("default")).toBeNull();
  });

  it("classifies configured / fresh / incomplete / dismissed", () => {
    expect(classifySetupOffer("default", configFile)).toBe("fresh");

    writeSetupStatus("default", "in_progress");
    expect(classifySetupOffer("default", configFile)).toBe("incomplete");

    writeSetupStatus("default", "dismissed");
    expect(classifySetupOffer("default", configFile)).toBe("dismissed");

    writeFileSync(
      configFile,
      `${JSON.stringify({ version: 1, instances: { default: defaultInstance() } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    expect(isConfigured("default", configFile)).toBe(true);
    expect(classifySetupOffer("default", configFile)).toBe("configured");
  });

  it("treats a missing config as not configured", () => {
    expect(isConfigured("default", configFile)).toBe(false);
    expect(existsSync(configFile)).toBe(false);
  });
});
