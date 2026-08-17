import { describe, expect, it } from "vitest";
import {
  ALL_HERDS,
  type HomeAgent,
  type HomeHerd,
  type HomeModel,
  MAX_HOME_BLOCKS,
  agentFromPane,
  buildHome,
  groupByWorkspace,
  needsYou,
} from "../../src/slack/home.js";
import { pane } from "../helpers/factories.js";

const herd = (overrides: Partial<HomeHerd> = {}): HomeHerd => ({
  herdId: "host:user:default",
  label: "personal",
  pid: 1234,
  instance: "default",
  socketPath: "/tmp/herdr.sock",
  herdrStatus: "connected",
  role: "primary",
  hostname: "host",
  user: "user",
  agentCount: 1,
  isLocal: true,
  updatedAt: Date.now(),
  ...overrides,
});

const agent = (overrides: Partial<HomeAgent> = {}): HomeAgent => ({
  ref: "r1",
  actionValue: "r1",
  terminalId: "term_1",
  agent: "claude",
  title: "a task",
  cwd: "/w",
  status: "working",
  workspaceId: "w1",
  workspaceLabel: "project",
  herdId: "host:user:default",
  herdLabel: "personal",
  ...overrides,
});

/**
 * A herd's own `herdrStatus` is what decides its view, and in the daemon it is
 * derived from the same tail status as `herdr` — so the fixture keeps them in
 * step unless a test sets `herds` explicitly.
 */
const model = (overrides: Partial<HomeModel> = {}): HomeModel => ({
  herds: [herd({ herdrStatus: overrides.herdr ?? "connected" })],
  localHerdId: "host:user:default",
  selectedHerdId: null,
  agents: [agent()],
  herdr: "connected",
  slackConnected: true,
  herdrSyncedAgoMs: 1_000,
  role: "primary",
  ...overrides,
});

const text = (blocks: Record<string, unknown>[]): string => JSON.stringify(blocks);

describe("needsYou", () => {
  it("surfaces blocked before done", () => {
    const result = needsYou([
      agent({ ref: "d", actionValue: "d", status: "done" }),
      agent({ ref: "b", actionValue: "b", status: "blocked" }),
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

  it("says the computer is unreachable instead of rendering a stale local list", () => {
    const blocks = buildHome(model({ herdr: "waiting", agents: [agent()] }));
    const rendered = text(blocks);
    expect(rendered).toContain("not reachable");
    expect(rendered).not.toContain("a task");
  });

  it("lists herds with pid so colliding labels stay distinguishable", () => {
    const blocks = buildHome(
      model({
        herds: [
          herd({ label: "work", pid: 111, herdId: "a", isLocal: true }),
          herd({
            label: "work",
            pid: 222,
            herdId: "b",
            isLocal: false,
            user: "ege",
            hostname: "mac",
            role: "satellite",
          }),
        ],
      }),
    );
    const rendered = text(blocks);
    expect(rendered).toContain("Herds");
    expect(rendered).toContain("pid `111`");
    expect(rendered).toContain("pid `222`");
    expect(rendered).toContain("ege@mac");
  });

  it("says no herdr is reachable when every herd is down", () => {
    const blocks = buildHome(
      model({
        herdr: "waiting",
        agents: [],
        herds: [herd({ herdrStatus: "waiting", agentCount: 0 })],
      }),
    );
    expect(text(blocks)).toContain("not reachable");
  });

  it("explains itself when there are no agents yet", () => {
    const blocks = buildHome(model({ agents: [] }));
    expect(text(blocks)).toContain("No agents running");
    expect(text(blocks)).toContain("New agent");
  });

  it("shows the needs-you section with a count", () => {
    const blocks = buildHome(
      model({
        agents: [
          agent({ status: "blocked" }),
          agent({ ref: "r2", actionValue: "r2", status: "done" }),
        ],
      }),
    );
    expect(text(blocks)).toContain("NEEDS YOU (2)");
  });

  it("omits the needs-you section when nothing wants attention", () => {
    expect(text(buildHome(model()))).not.toContain("NEEDS YOU");
  });

  it("carries only an opaque ref in button values", () => {
    // Never a pane id: pane.move reassigns those, so a stale button could reach
    // a different live terminal.
    const blocks = buildHome(
      model({
        agents: [agent({ ref: "opaque-ref", actionValue: "opaque-ref", status: "blocked" })],
      }),
    );
    const rendered = text(blocks);
    expect(rendered).toContain("opaque-ref");
    expect(rendered).not.toContain("w1:p");
    expect(rendered).not.toContain("term_1");
  });

  it("reports reconnecting to Slack in the footer", () => {
    expect(text(buildHome(model({ slackConnected: false })))).toContain("reconnecting");
  });

  it("shows how stale herdr sync is, and that Refresh re-syncs", () => {
    expect(text(buildHome(model({ herdrSyncedAgoMs: 45_000 })))).toContain("herdr synced 45s ago");
    expect(text(buildHome(model({ herdrSyncedAgoMs: 500 })))).toContain("herdr synced just now");
  });

  it("groups agents under their workspace", () => {
    const blocks = buildHome(
      model({
        agents: [
          agent({ workspaceLabel: "alpha" }),
          agent({ ref: "r2", actionValue: "r2", workspaceLabel: "beta" }),
        ],
      }),
    );
    const rendered = text(blocks);
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
  });

  it("folds the herd's identity under its name instead of repeating it", () => {
    const blocks = buildHome(model());
    const [header, detail] = blocks;
    expect((header?.text as { text: string }).text).toBe("🐑 Herd · personal");
    // Directly under the title, and only once.
    expect(detail?.type).toBe("context");
    expect(JSON.stringify(detail)).toContain("pid `1234`");
    expect(text(blocks).match(/pid /g)).toHaveLength(1);
    expect(text(blocks)).not.toContain("*Herds*");
  });

  it("pluralises the agent count correctly", () => {
    expect(text(buildHome(model()))).toContain("1 agent");
    expect(
      text(buildHome(model({ agents: [agent(), agent({ ref: "r2", actionValue: "r2" })] }))),
    ).toContain("2 agents");
  });
});

describe("more than one herd", () => {
  const work = herd({ herdId: "work", label: "work", pid: 111, agentCount: 2 });
  const personal = herd({
    herdId: "personal",
    label: "personal",
    pid: 222,
    agentCount: 1,
    isLocal: false,
    user: "ege",
    hostname: "mac",
    role: "satellite",
  });
  const workAgent = agent({ ref: "w1", actionValue: "w1", herdId: "work", herdLabel: "work" });
  const personalAgent = agent({
    ref: "p1",
    actionValue: "personal\u001fp1",
    terminalId: "term_p",
    title: "personal task",
    herdId: "personal",
    herdLabel: "personal",
  });

  const twoHerds = (overrides: Partial<HomeModel> = {}) =>
    model({
      herds: [work, personal],
      localHerdId: "work",
      agents: [workAgent, personalAgent],
      ...overrides,
    });

  it("opens on an overview of every herd, not one herd's agents", () => {
    const rendered = text(buildHome(twoHerds()));
    expect(rendered).toContain("🐑 Herds · 2");
    expect(rendered).toContain("pid `111`");
    expect(rendered).toContain("pid `222`");
    // The agent list belongs to the drill-down, not the overview.
    expect(rendered).not.toContain("*project*");
  });

  it("offers each herd as a way in", () => {
    const rendered = text(buildHome(twoHerds()));
    expect(rendered).toContain('"action_id":"home_select_herd","value":"work"');
    expect(rendered).toContain('"action_id":"home_select_herd","value":"personal"');
  });

  it("says which herd needs you from the overview", () => {
    const rendered = text(
      buildHome(
        twoHerds({
          agents: [workAgent, { ...personalAgent, status: "blocked" }],
        }),
      ),
    );
    expect(rendered).toContain("1 waiting on you");
    expect(rendered).toContain("NEEDS YOU (1)");
  });

  it("shows only the selected herd's agents once you drill in", () => {
    const rendered = text(buildHome(twoHerds({ selectedHerdId: "personal" })));
    expect(rendered).toContain("🐑 Herd · personal");
    expect(rendered).toContain("personal task");
    expect(rendered).not.toContain("a task");
    // And a way back out.
    expect(rendered).toContain(`"value":"${ALL_HERDS}"`);
  });

  it("routes a foreign agent's Open through its own herd", () => {
    const rendered = text(buildHome(twoHerds({ selectedHerdId: "personal" })));
    expect(rendered).toContain("personal\\u001fp1");
  });

  it("skips the overview when there is only one herd to choose", () => {
    // An extra tap to see your only machine is pure friction.
    const rendered = text(buildHome(model()));
    expect(rendered).toContain("🐑 Herd · personal");
    expect(rendered).not.toContain(ALL_HERDS);
  });

  it("keeps New agent while one herd is reachable, even if another is asleep", () => {
    const rendered = text(
      buildHome(twoHerds({ herds: [work, { ...personal, herdrStatus: "waiting" }] })),
    );
    expect(rendered).toContain("home_new_agent");
    expect(rendered).toContain("herdr down");
  });

  it("drops New agent when the herd you are looking at is asleep", () => {
    const rendered = text(
      buildHome(
        twoHerds({
          herds: [work, { ...personal, herdrStatus: "waiting" }],
          selectedHerdId: "personal",
        }),
      ),
    );
    expect(rendered).not.toContain("home_new_agent");
    expect(rendered).toContain("not reachable");
  });

  it("explains an empty registry rather than rendering a bare header", () => {
    const rendered = text(buildHome(model({ herds: [], agents: [] })));
    expect(rendered).toContain("No herds are reporting in");
  });
});

describe("agentFromPane", () => {
  it("prefers the stripped terminal title", () => {
    const result = agentFromPane(
      pane({ terminal_title_stripped: "clean title" }),
      "r1",
      "project",
      "working",
    );
    expect(result.title).toBe("clean title");
  });

  it("degrades gracefully when a pane has no title or agent", () => {
    const result = agentFromPane(
      pane({ terminal_title_stripped: null, title: null, agent: null, cwd: null }),
      "r1",
      "project",
      "unknown",
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
        actionValue: `r${i}`,
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
    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain("NEEDS YOU");
    expect(rendered).toContain("task 0");
    expect(rendered).toMatch(/and \d+ more/);
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
    const blocks = buildHome({ ...model(), agents: [agent({ ref: "", actionValue: "" })] });
    const rendered = JSON.stringify(blocks);

    expect(rendered).not.toContain('"value":""');
    // The agent is still listed; it just cannot be opened yet.
    expect(rendered).toContain("a task");
  });

  it("carries a thread-opening url on the Open button", () => {
    const link = "https://acme.slack.com/archives/D1/p111222?thread_ts=111.222&cid=D1";
    const blocks = buildHome({
      ...model(),
      agents: [agent({ ref: "abc", actionValue: "abc", status: "blocked", permalink: link })],
    });
    const rendered = text(blocks);
    expect(rendered).toContain(link);
    expect(rendered).toContain("home_open_session");
  });

  it("never emits an empty value for a blocked agent either", () => {
    const blocks = buildHome({
      ...model(),
      agents: [agent({ ref: "", actionValue: "", status: "blocked" })],
    });
    expect(JSON.stringify(blocks)).not.toContain('"value":""');
  });
});
