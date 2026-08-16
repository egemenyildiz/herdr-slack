import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "../../src/herdr/client.js";
import { HerdrError } from "../../src/herdr/types.js";
import { pane, snapshot } from "../helpers/factories.js";
import { FakeHerdr, NO_REPLY } from "../helpers/fake-herdr.js";

describe("HerdrClient", () => {
  let fake: FakeHerdr;
  let client: HerdrClient;

  beforeEach(async () => {
    fake = await FakeHerdr.start();
    client = new HerdrClient(fake.socketPath, 1_000);
  });

  afterEach(async () => {
    await fake.stop();
  });

  it("pings a live server", async () => {
    await expect(client.ping()).resolves.toBe(true);
  });

  it("reports a dead server rather than throwing", async () => {
    const dead = new HerdrClient("/tmp/definitely-not-a-herdr-socket.sock", 300);
    await expect(dead.ping(300)).resolves.toBe(false);
  });

  it("unwraps a snapshot", async () => {
    fake.on("session.snapshot", () => ({ snapshot: snapshot({ panes: [pane()] }) }));
    const result = await client.snapshot();
    expect(result.protocol).toBe(19);
    expect(result.panes).toHaveLength(1);
  });

  it("turns a herdr error into a typed HerdrError", async () => {
    fake.on("pane.get", () => new Error("pane not found"));
    const error = await client.paneGet("w9:p9").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("not_found");
    expect((error as HerdrError).isNotFound).toBe(true);
    expect((error as HerdrError).method).toBe("pane.get");
  });

  it("times out instead of hanging when the server never answers", async () => {
    fake.on("agent.list", () => NO_REPLY);
    const error = await client.request("agent.list", {}, 150).catch((e: unknown) => e);
    expect((error as HerdrError).code).toBe("timeout");
  });

  it("sends prompt text with the wait option herdr uses to confirm delivery", async () => {
    fake.on("agent.prompt", () => ({ ok: true }));
    await client.prompt("w1:p1", "do the thing", { until: ["idle", "blocked"], timeout_ms: 5000 });

    const sent = fake.requests.find((r) => r.method === "agent.prompt");
    expect(sent?.params).toEqual({
      target: "w1:p1",
      text: "do the thing",
      wait: { until: ["idle", "blocked"], timeout_ms: 5000 },
    });
  });

  it("sends bare keys without an implicit Enter", async () => {
    fake.on("agent.send_keys", () => ({ ok: true }));
    await client.sendKeys("w1:p1", ["2"]);

    const sent = fake.requests.find((r) => r.method === "agent.send_keys");
    expect(sent?.params).toEqual({ target: "w1:p1", keys: ["2"] });
  });

  it("always strips ansi when reading, and omits lines when unset", async () => {
    fake.on("pane.read", () => ({ read: { text: "hello" } }));
    await client.read("w1:p1", "visible");

    const sent = fake.requests.find((r) => r.method === "pane.read");
    // pane.read takes pane_id; agent.* takes target. Asserting the wrong one
    // here is what let the real bug through.
    expect(sent?.params).toEqual({ pane_id: "w1:p1", source: "visible", strip_ansi: true });
  });

  it("defaults collection responses to empty rather than undefined", async () => {
    fake.on("agent.list", () => ({}));
    await expect(client.agentList()).resolves.toEqual([]);
  });

  it("survives a response split across chunks", async () => {
    // Framing is the whole reason this test uses a real socket.
    const big = "x".repeat(200_000);
    fake.on("pane.read", () => ({ read: { text: big } }));
    await expect(client.read("w1:p1", "recent")).resolves.toHaveLength(200_000);
  });

  it("reports a connection that closes before answering", async () => {
    fake.on("pane.get", () => {
      fake.dropConnections();
      return { pane: pane() };
    });
    const error = await client.paneGet("w1:p1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HerdrError);
  });
});
