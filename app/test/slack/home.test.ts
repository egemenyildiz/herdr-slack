import { describe, expect, it } from "vitest";
import {
  type HomeAgent,
  type HomeModel,
  MAX_HOME_BLOCKS,
  agentFromPane,
  buildHome,
  groupByWorkspace,
  needsYou,
} from "../../src/slack/home.js";
import { pane } from "../helpers/factories.js";

const agent = (overrides: Partial<HomeAgent> = {}): HomeAgent => ({
  ref: "r1",
  terminalId: "term_1",
  agent: "claude",
  title: "a task",
  cwd: "/w",
  status: "working",
  workspaceId: "w1",
  workspaceLabel: "project",
  ...overrides,
});

const model = (overrides: Partial<HomeModel> = {}): HomeModel => ({
  instanceLabel: "personal",
  agents: [agent()],
  herdr: "connected",
  slackConnected: true,
  syncedAgoMs: 1_000,
  ...overrides,
});

const text = (blocks: Record<string, unknown>[]): string => JSON.stringify(blocks);

describe("needsYou", () => {
  it("surfaces blocked before done", () => {
    const result = needsYou([
      agent({ ref: "d", status: "done" }),
      agent({ ref: "b", status: "blocked" }),
    ]);
    expect(result.map((a) => a.ref)).toEqual(["b", "d"]);
  });

  it("ignores agents that are simply working", () => {
    expect(needsYou([agent({ status: "working" }), agent({ status: "idle" })])).toEqual([]);
  });

  it("falls back to the workspace id when there is no label", () => {
    const groups = groupByWorkspace([agent({ workspaceLabel: "", workspaceId: "w9" })]);
    expect([...groups.keys()]).toEqual(["w9"]);
  });
});

describe("buildHome", () => {
  it("always offers refresh and new-agent while herdr is up", () => {
    const blocks = buildHome(model());
    expect(text(blocks)).toContain("home_refresh");
    expect(text(blocks)).toContain("home_new_agent");
  });

  it("drops New agent when herdr is down, but keeps Refresh", () => {
    const blocks = buildHome(model({ herdr: "waiting", agents: [agent()] }));
    const rendered = text(blocks);
    expect(rendered).toContain("home_refresh");
    expect(rendered).not.toContain("home_new_agent");
  });

  it("says the computer is unreachable instead of rendering a stale list", () => {
    // Showing the last known agents while herdr is unreachable would be
    // confidently wrong, which is worse than showing nothing.
    const blocks = buildHome(model({ herdr: "waiting", agents: [agent()] }));
    const rendered = text(blocks);
    expect(rendered).toContain("not reachable");
    expect(rendered).not.toContain("a task");
  });

  it("explains itself when there are no agents yet", () => {
    const blocks = buildHome(model({ agents: [] }));
    expect(text(blocks)).toContain("No agents running");
    expect(text(blocks)).toContain("New agent");
  });

  it("shows the needs-you section with a count", () => {
    const blocks = buildHome(
      model({ agents: [agent({ status: "blocked" }), agent({ ref: "r2", status: "done" })] }),
    );
    expect(text(blocks)).toContain("NEEDS YOU (2)");
  });

  it("omits the needs-you section when nothing wants attention", () => {
    expect(text(buildHome(model()))).not.toContain("NEEDS YOU");
  });

  it("carries only an opaque ref in button values", () => {
    // Never a pane id: pane.move reassigns those, so a stale button could reach
    // a different live terminal.
    const blocks = buildHome(model({ agents: [agent({ ref: "opaque-ref", status: "blocked" })] }));
    const rendered = text(blocks);
    expect(rendered).toContain("opaque-ref");
    expect(rendered).not.toContain("w1:p");
    expect(rendered).not.toContain("term_1");
  });

  it("reports reconnecting to Slack in the footer", () => {
    expect(text(buildHome(model({ slackConnected: false })))).toContain("reconnecting");
  });

  it("shows how stale the view is, so a dead socket is never invisible", () => {
    expect(text(buildHome(model({ syncedAgoMs: 45_000 })))).toContain("synced 45s ago");
    expect(text(buildHome(model({ syncedAgoMs: 500 })))).toContain("synced just now");
  });

  it("groups agents under their workspace", () => {
    const blocks = buildHome(
      model({
        agents: [agent({ workspaceLabel: "alpha" }), agent({ ref: "r2", workspaceLabel: "beta" })],
      }),
    );
    const rendered = text(blocks);
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
  });

  it("pluralises the agent count correctly", () => {
    expect(text(buildHome(model()))).toContain("1 agent");
    expect(text(buildHome(model({ agents: [agent(), agent({ ref: "r2" })] })))).toContain(
      "2 agents",
    );
  });
});

describe("agentFromPane", () => {
  it("prefers the stripped terminal title", () => {
    const result = agentFromPane(
      pane({ terminal_title_stripped: "clean title" }),
      "r1",
      "project",
      "working",
      false,
    );
    expect(result.title).toBe("clean title");
  });

  it("degrades gracefully when a pane has no title or agent", () => {
    const result = agentFromPane(
      pane({ terminal_title_stripped: null, title: null, agent: null, cwd: null }),
      "r1",
      "project",
      "unknown",
      false,
    );
    expect(result.title).toBe("(untitled)");
    expect(result.agent).toBe("agent");
    expect(result.cwd).toBe("");
  });
});

describe("a herd too large for one view", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      agent({
        ref: `r${i}`,
        terminalId: `term_${i}`,
        title: `task ${i}`,
        status: i === 0 ? "blocked" : "working",
        workspaceId: `w${i % 5}`,
        workspaceLabel: `workspace ${i % 5}`,
      }),
    );

  it("never exceeds Slack's block cap, which would blank the whole view", () => {
    const blocks = buildHome({ ...model(), agents: many(300) });
    expect(blocks.length).toBeLessThanOrEqual(MAX_HOME_BLOCKS);
  });

  it("still shows every blocked agent, and says how many it hid", () => {
    const blocks = buildHome({ ...model(), agents: many(300) });
    const text = JSON.stringify(blocks);
    expect(text).toContain("NEEDS YOU");
    expect(text).toContain("task 0");
    expect(text).toMatch(/and \d+ more/);
  });

  it("leaves a small herd untouched", () => {
    const blocks = buildHome({ ...model(), agents: many(3) });
    expect(JSON.stringify(blocks)).not.toContain("more.");
  });
});

describe("an agent with no ref yet", () => {
  it("renders the row without a button, rather than an empty-valued one", () => {
    // Slack rejects a button whose value is "" — and rejects the *entire view*
    // with it, so one unregistered agent blanked the whole Home tab.
    const blocks = buildHome({ ...model(), agents: [agent({ ref: "" })] });
    const rendered = JSON.stringify(blocks);

    expect(rendered).not.toContain('"value":""');
    // The agent is still listed; it just cannot be opened yet.
    expect(rendered).toContain("a task");
  });

  it("carries a thread-opening url on the Open button", () => {
    const link = "https://acme.slack.com/archives/D1/p111222?thread_ts=111.222&cid=D1";
    const blocks = buildHome({
      ...model(),
      agents: [agent({ ref: "abc", status: "blocked", permalink: link })],
    });
    const rendered = text(blocks);
    expect(rendered).toContain(link);
    expect(rendered).toContain("home_open_session");
  });

  it("never emits an empty value for a blocked agent either", () => {
    const blocks = buildHome({ ...model(), agents: [agent({ ref: "", status: "blocked" })] });
    expect(JSON.stringify(blocks)).not.toContain('"value":""');
  });
});
