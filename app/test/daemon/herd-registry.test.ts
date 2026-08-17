import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_STALE_MS,
  HerdRegistry,
  OWNERSHIP_STALE_MS,
  decodeHerdRef,
  defaultHerdRegistryDir,
  deriveHerdId,
  encodeHerdRef,
} from "../../src/daemon/herd-registry.js";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "herd-reg-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("herd ref encoding", () => {
  it("leaves local refs bare", () => {
    expect(encodeHerdRef("local", "abc", "local")).toBe("abc");
  });

  it("returns empty when the ref is empty", () => {
    expect(encodeHerdRef("other", "", "local")).toBe("");
  });

  it("prefixes foreign refs so the primary can route them", () => {
    expect(encodeHerdRef("other", "abc", "local")).toBe("other\u001fabc");
    expect(decodeHerdRef("other\u001fabc", "local")).toEqual({ herdId: "other", ref: "abc" });
  });

  it("treats a bare value as local", () => {
    expect(decodeHerdRef("abc", "local")).toEqual({ herdId: "local", ref: "abc" });
  });

  it("derives a stable herd id from host, user, and instance", () => {
    expect(deriveHerdId("default", "mac", "ege")).toBe("mac:ege:default");
  });

  it("defaults the registry under the config dir", () => {
    expect(defaultHerdRegistryDir("/cfg")).toBe(path.join("/cfg", "herd-registry"));
  });
});

describe("HerdRegistry ownership", () => {
  it("lets the first claimant become primary", async () => {
    const registry = new HerdRegistry(scratch());
    expect(await registry.claimOwnership({ appId: "A1", herdId: "h1", pid: process.pid })).toBe(
      true,
    );
    expect(await registry.claimOwnership({ appId: "A1", herdId: "h2", pid: process.pid })).toBe(
      false,
    );
    expect(registry.readOwnership("A1")?.herdId).toBe("h1");
  });

  it("lets the same herd renew its claim", async () => {
    const registry = new HerdRegistry(scratch());
    await registry.claimOwnership({ appId: "A1", herdId: "h1", pid: process.pid, now: 1_000 });
    expect(
      await registry.claimOwnership({ appId: "A1", herdId: "h1", pid: process.pid, now: 2_000 }),
    ).toBe(true);
    registry.renewOwnership("A1", "h1", process.pid, 3_000);
    expect(registry.readOwnership("A1")?.updatedAt).toBe(3_000);
    registry.renewOwnership("A1", "h2", process.pid, 4_000);
    expect(registry.readOwnership("A1")?.updatedAt).toBe(3_000);
  });

  it("reclaims ownership when the prior owner is stale", async () => {
    const registry = new HerdRegistry(scratch());
    await registry.claimOwnership({
      appId: "A1",
      herdId: "h1",
      pid: process.pid,
      now: 1_000,
    });
    expect(
      await registry.claimOwnership({
        appId: "A1",
        herdId: "h2",
        pid: process.pid,
        now: 1_000 + OWNERSHIP_STALE_MS + 1,
      }),
    ).toBe(true);
    expect(registry.readOwnership("A1")?.herdId).toBe("h2");
  });

  it("aggregates fresh heartbeats for one app only", () => {
    const registry = new HerdRegistry(scratch());
    const base = {
      pid: 1,
      instance: "default",
      socketPath: "/tmp/a.sock",
      teamId: "T1",
      herdrStatus: "connected" as const,
      agents: [],
      updatedAt: Date.now(),
      role: "primary" as const,
      hostname: "mac",
      user: "a",
    };
    registry.writeHeartbeat({ ...base, herdId: "h1", label: "work", appId: "A1" });
    registry.writeHeartbeat({ ...base, herdId: "h2", label: "personal", appId: "A1", pid: 2 });
    registry.writeHeartbeat({ ...base, herdId: "h3", label: "other-app", appId: "A2" });
    registry.writeHeartbeat({
      ...base,
      herdId: "stale",
      label: "gone",
      appId: "A1",
      updatedAt: Date.now() - HEARTBEAT_STALE_MS - 1,
    });
    expect(
      registry
        .listHeartbeats("A1")
        .map((h) => h.label)
        .sort(),
    ).toEqual(["personal", "work"]);
    registry.removeHeartbeat("h1");
    expect(registry.listHeartbeats("A1").map((h) => h.herdId)).toEqual(["h2"]);
  });

  it("ignores corrupt heartbeat files", () => {
    const dir = scratch();
    const registry = new HerdRegistry(dir);
    writeFileSync(path.join(dir, "heartbeats", "bad.json"), "{not-json\n", { mode: 0o666 });
    expect(registry.listHeartbeats("A1")).toEqual([]);
  });

  it("rounds-trips a command for a satellite", () => {
    const registry = new HerdRegistry(scratch());
    registry.enqueueCommand({
      id: "c1",
      op: "open_session",
      herdId: "h2",
      ref: "abc",
      channel: "D1",
      userId: "U1",
      createdAt: Date.now(),
    });
    expect(registry.listCommands("h2")).toHaveLength(1);
    expect(registry.listCommands("missing")).toEqual([]);
    const pending = registry.listCommands("h2")[0];
    expect(pending).toBeDefined();
    if (!pending) return;
    registry.completeCommand(pending, {
      ok: true,
      completedAt: Date.now(),
    });
    expect(registry.listCommands("h2")).toHaveLength(0);
    expect(registry.takeResult("c1")?.ok).toBe(true);
    expect(registry.takeResult("c1")).toBeNull();
  });
});
