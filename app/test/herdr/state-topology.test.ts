import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionState } from "../../src/herdr/state.js";
import type { SessionSnapshot } from "../../src/herdr/types.js";
import { pane, tab, workspace } from "../helpers/factories.js";

describe("SessionState topology", () => {
  let state: SessionState;

  beforeEach(() => {
    state = new SessionState();
    state.markPrimed();
  });

  afterEach(() => state.dispose());

  it("tracks workspaces", () => {
    state.apply({ type: "workspace_created", workspace: workspace({ workspace_id: "w1" }) });
    expect(state.workspaces.get("w1")?.label).toBe("project");

    state.apply({
      type: "workspace_updated",
      workspace: workspace({ workspace_id: "w1", pane_count: 3 }),
    });
    expect(state.workspaces.get("w1")?.pane_count).toBe(3);
  });

  it("renames a workspace in place", () => {
    state.apply({ type: "workspace_created", workspace: workspace({ workspace_id: "w1" }) });
    state.apply({ type: "workspace_renamed", workspace_id: "w1", label: "renamed" });
    expect(state.workspaces.get("w1")?.label).toBe("renamed");
  });

  it("ignores a rename for a workspace it has never seen", () => {
    state.apply({ type: "workspace_renamed", workspace_id: "ghost", label: "nope" });
    expect(state.workspaces.has("ghost")).toBe(false);
  });

  it("drops a closed workspace's tabs along with it", () => {
    state.apply({ type: "tab_created", tab: tab({ tab_id: "w1:t1", workspace_id: "w1" }) });
    state.apply({ type: "tab_created", tab: tab({ tab_id: "w2:t1", workspace_id: "w2" }) });

    state.apply({ type: "workspace_closed", workspace_id: "w1" });

    expect(state.tabs.has("w1:t1")).toBe(false);
    expect(state.tabs.has("w2:t1")).toBe(true);
  });

  it("tracks tab create, rename, and close", () => {
    state.apply({ type: "tab_created", tab: tab({ tab_id: "w1:t1", label: "one" }) });
    expect(state.tabs.get("w1:t1")?.label).toBe("one");

    state.apply({ type: "tab_renamed", tab: tab({ tab_id: "w1:t1", label: "two" }) });
    expect(state.tabs.get("w1:t1")?.label).toBe("two");

    state.apply({ type: "tab_closed", tab_id: "w1:t1" });
    expect(state.tabs.has("w1:t1")).toBe(false);
  });

  it("ignores event kinds it does not model", () => {
    expect(() => state.apply({ type: "layout_updated", whatever: 1 })).not.toThrow();
    expect(() => state.apply({ type: "pane_focused", pane_id: "w1:p1" })).not.toThrow();
  });

  it("ignores a close for a pane id it never indexed", () => {
    expect(() =>
      state.apply({ type: "pane_closed", pane_id: "w9:p9", workspace_id: "w9" }),
    ).not.toThrow();
  });

  it("tolerates a snapshot missing its collections", () => {
    // Defensive: a partial snapshot must not wipe state via undefined iteration.
    const partial = { version: "0.8.0", protocol: 19 } as SessionSnapshot;
    expect(() => state.applySnapshot(partial)).not.toThrow();
    expect(state.agentPanes()).toEqual([]);
  });

  it("re-emits nothing for an unchanged pane", () => {
    const p = pane({ revision: 2 });
    state.apply({ type: "pane_created", pane: p });
    let outputs = 0;
    state.on("output", () => {
      outputs += 1;
    });
    state.apply({ type: "pane_updated", pane: { ...p } });
    expect(outputs).toBe(0);
  });

  it("reports the committed status for a terminal", () => {
    const p = pane({ agent_status: "working" });
    state.apply({ type: "pane_created", pane: p });
    expect(state.statusOf(p.terminal_id)).toBe("working");
    expect(state.statusOf("nobody")).toBeUndefined();
  });

  it("has no pane for an unknown terminal", () => {
    expect(state.paneByTerminal("nope")).toBeUndefined();
    expect(state.currentPaneId("nope")).toBeUndefined();
  });
});
