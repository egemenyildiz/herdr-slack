import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_DEBOUNCE_MS, SessionState } from "../../src/herdr/state.js";
import type { PaneGone, StatusTransition } from "../../src/herdr/state.js";
import { pane, snapshot, withStatus } from "../helpers/factories.js";

describe("SessionState", () => {
  let state: SessionState;

  beforeEach(() => {
    vi.useFakeTimers();
    state = new SessionState();
  });

  afterEach(() => {
    state.dispose();
    vi.useRealTimers();
  });

  describe("priming", () => {
    it("records existing statuses without announcing them", () => {
      const seen: StatusTransition[] = [];
      state.on("transition", (t) => seen.push(t));

      // The connect-time replay: everything that already existed.
      state.apply({ type: "pane_created", pane: pane({ agent_status: "blocked" }) });
      vi.advanceTimersByTime(60_000);

      expect(seen).toEqual([]);
    });

    it("announces transitions once primed", () => {
      const seen: StatusTransition[] = [];
      state.on("transition", (t) => seen.push(t));
      const p = pane({ agent_status: "working" });
      state.apply({ type: "pane_created", pane: p });
      state.markPrimed();

      state.apply({ type: "pane_updated", pane: withStatus(p, "blocked") });
      vi.advanceTimersByTime(STATUS_DEBOUNCE_MS.blocked);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ terminalId: p.terminal_id, from: "working", to: "blocked" });
    });
  });

  describe("status debounce", () => {
    beforeEach(() => state.markPrimed());

    it("suppresses a flap that resolves inside the window", () => {
      const seen: StatusTransition[] = [];
      const p = pane({ agent_status: "working" });
      state.apply({ type: "pane_created", pane: p });
      state.on("transition", (t) => seen.push(t));

      // Agent blips to done between steps, then keeps working.
      state.apply({ type: "pane_updated", pane: withStatus(p, "done") });
      vi.advanceTimersByTime(STATUS_DEBOUNCE_MS.done - 1);
      state.apply({ type: "pane_updated", pane: withStatus(p, "working") });
      vi.advanceTimersByTime(60_000);

      expect(seen).toEqual([]);
    });

    it("announces a status that holds past its window", () => {
      const seen: StatusTransition[] = [];
      const p = pane({ agent_status: "working" });
      state.apply({ type: "pane_created", pane: p });
      state.on("transition", (t) => seen.push(t));

      state.apply({ type: "pane_updated", pane: withStatus(p, "done") });
      vi.advanceTimersByTime(STATUS_DEBOUNCE_MS.done - 1);
      expect(seen).toEqual([]);

      vi.advanceTimersByTime(2);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.to).toBe("done");
    });

    it("announces working immediately — there is nothing to wait out", () => {
      const seen: StatusTransition[] = [];
      const p = pane({ agent_status: "idle" });
      state.apply({ type: "pane_created", pane: p });
      state.markPrimed();
      state.on("transition", (t) => seen.push(t));

      state.apply({ type: "pane_updated", pane: withStatus(p, "working") });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.to).toBe("working");
    });

    it("does not announce a status for a terminal that vanished mid-window", () => {
      const seen: StatusTransition[] = [];
      const p = pane({ agent_status: "working" });
      state.apply({ type: "pane_created", pane: p });
      state.on("transition", (t) => seen.push(t));

      state.apply({ type: "pane_updated", pane: withStatus(p, "blocked") });
      state.apply({ type: "pane_closed", pane_id: p.pane_id, workspace_id: p.workspace_id });
      vi.advanceTimersByTime(60_000);

      expect(seen).toEqual([]);
    });
  });

  describe("identity and the reverse index", () => {
    beforeEach(() => state.markPrimed());

    it("resolves a terminal to its current pane after a move", () => {
      const before = pane({ pane_id: "w1:p3", terminal_id: "term_x" });
      state.apply({ type: "pane_created", pane: before });

      const after = { ...before, pane_id: "w2:p1", workspace_id: "w2" };
      state.apply({ type: "pane_moved", pane: after, previous_pane_id: "w1:p3" });

      expect(state.currentPaneId("term_x")).toBe("w2:p1");
    });

    it("forgets the old pane id on a move, so a recycled id cannot mis-resolve", () => {
      const before = pane({ pane_id: "w1:p3", terminal_id: "term_x" });
      state.apply({ type: "pane_created", pane: before });
      state.apply({
        type: "pane_moved",
        pane: { ...before, pane_id: "w2:p1", workspace_id: "w2" },
        previous_pane_id: "w1:p3",
      });

      // A different terminal later occupies the vacated id.
      const other = pane({ pane_id: "w1:p3", terminal_id: "term_y" });
      state.apply({ type: "pane_created", pane: other });

      expect(state.terminalByPane.get("w1:p3")).toBe("term_y");
      expect(state.currentPaneId("term_x")).toBe("w2:p1");
    });

    it("ends the right session on close, though the event carries no terminal_id", () => {
      const gone: PaneGone[] = [];
      const p = pane({ pane_id: "w1:p7", terminal_id: "term_z" });
      state.apply({ type: "pane_created", pane: p });
      state.on("paneGone", (g) => gone.push(g));

      // pane_closed carries only {pane_id, workspace_id} — the reverse index is
      // the only way back to the terminal.
      state.apply({ type: "pane_closed", pane_id: "w1:p7", workspace_id: "w1" });

      expect(gone).toEqual([{ terminalId: "term_z", paneId: "w1:p7" }]);
      expect(state.paneByTerminal("term_z")).toBeUndefined();
    });

    it("ignores a close for a pane id the terminal has already moved off", () => {
      const gone: PaneGone[] = [];
      const before = pane({ pane_id: "w1:p3", terminal_id: "term_x" });
      state.apply({ type: "pane_created", pane: before });
      state.apply({
        type: "pane_moved",
        pane: { ...before, pane_id: "w2:p1", workspace_id: "w2" },
        previous_pane_id: "w1:p3",
      });
      state.on("paneGone", (g) => gone.push(g));

      state.apply({ type: "pane_closed", pane_id: "w1:p3", workspace_id: "w1" });

      expect(gone).toEqual([]);
      expect(state.currentPaneId("term_x")).toBe("w2:p1");
    });

    it("drops panes belonging to a closed workspace", () => {
      const p = pane({ workspace_id: "w9", pane_id: "w9:p1" });
      state.apply({ type: "pane_created", pane: p });
      state.apply({ type: "workspace_closed", workspace_id: "w9" });

      expect(state.paneByTerminal(p.terminal_id)).toBeUndefined();
      expect(state.terminalByPane.get("w9:p1")).toBeUndefined();
    });
  });

  describe("output signal", () => {
    beforeEach(() => state.markPrimed());

    it("emits when the revision advances", () => {
      const seen: number[] = [];
      const p = pane({ revision: 4 });
      state.apply({ type: "pane_created", pane: p });
      state.on("output", (o) => seen.push(o.revision));

      state.apply({ type: "pane_updated", pane: { ...p, revision: 5 } });
      state.apply({ type: "pane_updated", pane: { ...p, revision: 6 } });

      expect(seen).toEqual([5, 6]);
    });

    it("stays quiet when only metadata changed", () => {
      const seen: number[] = [];
      const p = pane({ revision: 4 });
      state.apply({ type: "pane_created", pane: p });
      state.on("output", (o) => seen.push(o.revision));

      state.apply({ type: "pane_updated", pane: { ...p, focused: true } });

      expect(seen).toEqual([]);
    });
  });

  describe("snapshot reconcile", () => {
    it("adopts the snapshot and drops terminals it no longer lists", () => {
      const stale = pane({ terminal_id: "term_stale" });
      const live = pane({ terminal_id: "term_live" });
      state.apply({ type: "pane_created", pane: stale });
      state.markPrimed();

      state.applySnapshot(snapshot({ panes: [live] }));

      expect(state.paneByTerminal("term_stale")).toBeUndefined();
      expect(state.paneByTerminal("term_live")).toBeDefined();
      expect(state.terminalByPane.get(stale.pane_id)).toBeUndefined();
    });

    it("syncs committed status silently while unprimed", () => {
      const p = pane({ terminal_id: "term_sync", agent_status: "idle" });
      state.apply({ type: "pane_created", pane: p });
      state.markPrimed();
      state.apply({
        type: "pane_updated",
        pane: { ...p, agent_status: "working", revision: 2 },
      });

      const seen: StatusTransition[] = [];
      state.on("transition", (t) => seen.push(t));
      state.markUnprimed();
      state.applySnapshot(snapshot({ panes: [{ ...p, agent_status: "idle", revision: 3 }] }));

      expect(seen).toEqual([]);
      expect(state.statusOf("term_sync")).toBe("idle");
    });
  });

  it("lists only panes running an agent", () => {
    state.apply({ type: "pane_created", pane: pane({ agent: "claude" }) });
    state.apply({ type: "pane_created", pane: pane({ agent: null }) });

    expect(state.agentPanes()).toHaveLength(1);
  });
});
