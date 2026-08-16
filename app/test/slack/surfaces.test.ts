import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import { RateBudget } from "../../src/daemon/budget.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { EventTail } from "../../src/herdr/events.js";
import { SessionState } from "../../src/herdr/state.js";
import { SessionRegistry } from "../../src/registry/registry.js";
import { Surfaces } from "../../src/slack/surfaces.js";
import { pane, workspace } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";
import { FakeTransport } from "../helpers/fake-transport.js";

const config = (overrides = {}) =>
  defaultInstance({
    label: "personal",
    slack: { botToken: "xoxb-1", appToken: "xapp-1", teamId: "T1", appId: "A1", botUserId: "UBOT" },
    allowedUsers: ["U1"],
    ...overrides,
  });

const ctx = (overrides = {}) => ({ teamId: "T1", userId: "U1", channel: "D1", ...overrides });

describe("Surfaces", () => {
  let dir: string;
  let transport: FakeTransport;
  let state: SessionState;
  let registry: SessionRegistry;
  let surfaces: Surfaces;
  let logs: string[];
  let fakeHerdr: FakeHerdr;
  let tail: EventTail;

  const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

  const build = async (cfg = config()) => {
    logs = [];
    transport = new FakeTransport();
    state = new SessionState();
    state.markPrimed();
    registry = new SessionRegistry("default");
    // A real socket so the tail reaches "connected" — Home deliberately hides
    // the agent list while herdr is unreachable, so a disconnected tail would
    // render the empty state instead.
    fakeHerdr = await FakeHerdr.start();
    tail = new EventTail(new HerdrClient(fakeHerdr.socketPath, 500), state);
    tail.start();
    await settle();
    surfaces = new Surfaces({
      config: cfg,
      instance: "default",
      transport,
      state,
      tail,
      registry,
      client: new HerdrClient(fakeHerdr.socketPath, 500),
      budget: new RateBudget({ totalPerMin: 100 }),
      log: (line) => logs.push(line),
    });
    surfaces.start();
    return surfaces;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-surf-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
  });

  afterEach(async () => {
    surfaces?.stop();
    tail?.stop();
    state?.dispose();
    await fakeHerdr?.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  describe("app home", () => {
    it("publishes for an allowlisted user", async () => {
      await build();
      await transport.emitHomeOpened(ctx());
      expect(transport.homes).toHaveLength(1);
      expect(transport.homes[0]?.userId).toBe("U1");
    });

    it("publishes nothing for a user who is not allowlisted", async () => {
      await build();
      await transport.emitHomeOpened(ctx({ userId: "U_INTRUDER" }));
      expect(transport.homes).toEqual([]);
      expect(logs.join()).toContain("not_allowed");
    });

    it("publishes nothing for another workspace", async () => {
      await build();
      await transport.emitHomeOpened(ctx({ teamId: "T_EVIL" }));
      expect(transport.homes).toEqual([]);
      expect(logs.join()).toContain("wrong_team");
    });

    it("renders live agents with their workspace label", async () => {
      await build();
      state.apply({ type: "workspace_created", workspace: workspace({ label: "posi" }) });
      state.apply({ type: "pane_created", pane: pane({ terminal_title_stripped: "fix auth" }) });
      surfaces.reconcileSessions();

      await transport.emitHomeOpened(ctx());
      const rendered = transport.lastHomeText();
      expect(rendered).toContain("posi");
      expect(rendered).toContain("fix auth");
    });

    it("never puts a terminal or pane id in a button", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ terminal_id: "term_secret" }) });
      surfaces.reconcileSessions();
      await transport.emitHomeOpened(ctx());

      const rendered = transport.lastHomeText();
      expect(rendered).not.toContain("term_secret");
      expect(rendered).not.toContain("w1:p");
    });

    it("survives Slack failing mid-publish", async () => {
      await build();
      transport.failNext = true;
      await transport.emitHomeOpened(ctx());
      expect(logs.join()).toContain("home publish failed");
    });

    it("stops publishing once the write budget is spent", async () => {
      logs = [];
      transport = new FakeTransport();
      state = new SessionState();
      registry = new SessionRegistry("default");
      const tail = new EventTail(new HerdrClient("/tmp/nope.sock", 100), state);
      surfaces = new Surfaces({
        config: config(),
        instance: "default",
        transport,
        state,
        tail,
        registry,
        client: new HerdrClient("/tmp/nope.sock", 100),
        // Just enough for the control reserve; the next call must be refused.
        budget: new RateBudget({ totalPerMin: 6 }),
        log: (line) => logs.push(line),
      });
      surfaces.start();

      for (let i = 0; i < 8; i += 1) await transport.emitHomeOpened(ctx());
      expect(transport.homes.length).toBeLessThanOrEqual(6);
      expect(logs.join()).toContain("rate budget exhausted");
    });
  });

  describe("actions", () => {
    it("refuses an action carrying a ref it never minted", async () => {
      await build();
      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_open_session",
        value: "forged-ref",
        triggerId: "t1",
      });
      expect(logs.join()).toContain("unknown_ref");
      // Shown only to the person who clicked, not posted into the DM.
      expect(transport.ephemerals.at(-1)?.text).toContain("older message");
      expect(transport.posted).toHaveLength(0);
    });

    it("refuses an action carrying a raw pane id", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ pane_id: "w1:p1" }) });
      surfaces.reconcileSessions();

      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_open_session",
        value: "w1:p1",
        triggerId: "t1",
      });
      expect(logs.join()).toContain("unknown_ref");
    });

    it("accepts an action carrying a minted ref", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ terminal_id: "term_ok" }) });
      surfaces.reconcileSessions();
      const ref = registry.get("term_ok")?.ref ?? "";

      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_open_session",
        value: ref,
        triggerId: "t1",
      });
      expect(logs.join()).toContain("terminal=term_ok");
    });

    it("fails closed for a ref whose terminal has ended", async () => {
      await build();
      state.apply({
        type: "pane_created",
        pane: pane({ terminal_id: "term_gone", pane_id: "w1:pX" }),
      });
      surfaces.reconcileSessions();
      const ref = registry.get("term_gone")?.ref ?? "";
      state.apply({ type: "pane_closed", pane_id: "w1:pX", workspace_id: "w1" });

      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_open_session",
        value: ref,
        triggerId: "t1",
      });
      expect(logs.join()).toContain("session_ended");
    });

    it("lets refresh through without needing a ref", async () => {
      await build();
      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_refresh",
        value: "refresh",
        triggerId: "t1",
      });
      expect(transport.homes).toHaveLength(1);
    });

    it("ignores refresh from a non-allowlisted user", async () => {
      await build();
      await transport.emitAction({
        ctx: ctx({ userId: "U_OTHER" }),
        actionId: "home_refresh",
        value: "refresh",
        triggerId: "t1",
      });
      expect(transport.homes).toEqual([]);
    });
  });

  describe("session reconciliation", () => {
    it("registers live agents and keeps their refs stable", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ terminal_id: "term_1" }) });
      surfaces.reconcileSessions();
      const first = registry.get("term_1")?.ref;

      surfaces.reconcileSessions();
      expect(registry.get("term_1")?.ref).toBe(first);
    });

    it("locks an ended session card once", async () => {
      await build();
      state.apply({ type: "workspace_created", workspace: workspace() });
      state.apply({
        type: "pane_created",
        pane: pane({ terminal_id: "term_1", pane_id: "w1:pY" }),
      });
      surfaces.reconcileSessions();
      registry.setThread("term_1", "D1", "111.1");

      state.apply({ type: "pane_closed", pane_id: "w1:pY", workspace_id: "w1" });
      // paneGone ends the session immediately; the sweep is the backstop for a
      // terminal that vanished while the daemon was down. Both must not post.
      await settle();
      surfaces.reconcileSessions();
      surfaces.reconcileSessions();
      await settle();

      const ended = transport.updated.filter((p) => JSON.stringify(p.blocks).includes("read-only"));
      expect(ended).toHaveLength(1);
      expect(ended[0]?.ts).toBe("111.1");
    });

    it("skips the sweep when herdr reports no workspaces at all", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ terminal_id: "term_1" }) });
      surfaces.reconcileSessions();
      // No workspace_created was applied, so workspaces.size is 0 — this is what
      // a mid-restore herdr looks like, and sweeping then would be unrecoverable.
      expect(logs.join()).toContain("orphan sweep skipped");
      expect(registry.get("term_1")?.ended).toBe(false);
    });
  });
});
