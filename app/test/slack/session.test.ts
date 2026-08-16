import { describe, expect, it } from "vitest";
import { GLYPH } from "../../src/slack/home.js";
import {
  SESSION_ACTIONS,
  type SessionView,
  blockedPromptBlocks,
  isExcluded,
  parseMenuChoiceValue,
  responseSections,
  sendsTerminalText,
  sessionCard,
  threadTitle,
  viewFromPane,
} from "../../src/slack/session.js";
import { pane } from "../helpers/factories.js";

const view = (overrides: Partial<SessionView> = {}): SessionView => ({
  ref: "ref123",
  agent: "claude",
  title: "fix auth",
  cwd: "/Users/dev/project",
  status: "blocked",
  workspaceLabel: "project",
  tabId: "w1:t1",
  ...overrides,
});

const json = (blocks: Record<string, unknown>[]): string => JSON.stringify(blocks);

describe("content modes", () => {
  it("only sends terminal text in full mode", () => {
    expect(sendsTerminalText("full")).toBe(true);
    expect(sendsTerminalText("summary")).toBe(false);
    expect(sendsTerminalText("titles")).toBe(false);
  });
});

describe("excludePaths", () => {
  it("matches a directory prefix", () => {
    expect(isExcluded("/work/secret-repo/src", ["/work/secret-repo"])).toBe(true);
  });

  it("does not match an unrelated directory", () => {
    expect(isExcluded("/work/other", ["/work/secret-repo"])).toBe(false);
  });

  it("ignores empty entries and empty cwd", () => {
    expect(isExcluded("", ["/w"])).toBe(false);
    expect(isExcluded("/w", [""])).toBe(false);
  });
});

describe("controls", () => {
  const record = (ended = false) => ({
    ref: "ref123",
    firstSeen: 0,
    ended,
    endedNotifiedAt: null,
    lastKnownPaneId: "w1:p1",
    agentKind: "claude",
    title: "fix auth",
    cwd: "/Users/dev/project",
    workspaceId: "w1",
    tabId: "w1:t1",
    lastStatus: "idle" as const,
  });

  it("says the agent's state in words, not only as a glyph", () => {
    expect(json(sessionCard(view({ status: "idle" }), record()).blocks)).toContain("*Idle*");
    expect(json(sessionCard(view({ status: "working" }), record()).blocks)).toContain("*Working*");
    expect(json(sessionCard(view({ status: "blocked" }), record()).blocks)).toContain(
      "*Waiting on you*",
    );
    expect(json(sessionCard(view({ status: "done" }), record()).blocks)).toContain("*Finished*");
    expect(json(sessionCard(view({ status: "unknown" }), record()).blocks)).toContain(
      "*State unknown*",
    );
  });

  it("says a Slack reply is in flight while its turn is working", () => {
    const working = {
      ...record(),
      turns: [{ id: "turn-1", prompt: "do it", status: "working" as const, createdAt: 1 }],
    };
    expect(json(sessionCard(view({ status: "idle" }), working).blocks)).toContain(
      "Working* on your reply",
    );
  });

  it("offers reply, refresh, history, and end", () => {
    const rendered = json(sessionCard(view({ status: "idle" }), record()).blocks);
    expect(rendered).toContain(SESSION_ACTIONS.reply);
    expect(rendered).toContain(SESSION_ACTIONS.refresh);
    expect(rendered).toContain(SESSION_ACTIONS.history);
    expect(rendered).toContain(SESSION_ACTIONS.end);
  });

  it("replaces controls once the session ends", () => {
    const rendered = json(sessionCard({ ...view(), ended: true }, record(true)).blocks);
    expect(rendered).not.toContain(SESSION_ACTIONS.reply);
    expect(rendered).not.toContain(SESSION_ACTIONS.end);
    expect(rendered).toContain("read-only");
  });

  it("strips every control when herdr is offline", () => {
    const rendered = json(
      sessionCard({ ...view({ status: "idle" }), herdrConnected: false }, record()).blocks,
    );
    expect(rendered).not.toContain(SESSION_ACTIONS.reply);
    expect(rendered).not.toContain(SESSION_ACTIONS.refresh);
    expect(rendered).not.toContain(SESSION_ACTIONS.history);
    expect(rendered).not.toContain(SESSION_ACTIONS.end);
    expect(rendered).toContain("Computer unreachable");
  });

  it("confirms End session and says the terminal is closed", () => {
    const rendered = json(sessionCard(view({ status: "idle" }), record()).blocks);
    expect(rendered).toContain("closes the terminal");
    expect(rendered).toContain("confirm");
  });

  it("hides Reply while a turn is working", () => {
    const working = {
      ...record(),
      turns: [
        {
          id: "turn-1",
          prompt: "do it",
          status: "working" as const,
          createdAt: 1,
        },
      ],
    };
    const rendered = json(sessionCard(view({ status: "working" }), working).blocks);
    expect(rendered).toContain("Working");
    expect(rendered).not.toContain(SESSION_ACTIONS.reply);
  });

  it("shows a stored prompt and response instead of terminal history", () => {
    const done = {
      ...record(),
      turns: [
        {
          id: "turn-1",
          prompt: "fix the test",
          response: "The test now passes.",
          status: "done" as const,
          createdAt: 1,
        },
      ],
    };
    const rendered = json(sessionCard(view({ status: "done" }), done).blocks);
    expect(rendered).toContain("fix the test");
    expect(rendered).toContain("The test now passes");
  });

  it("shows a long latest reply completely across multiple section blocks", () => {
    const response = `${"first paragraph ".repeat(200)}\n${"last paragraph ".repeat(200)}`;
    const done = {
      ...record(),
      latestResponse: response,
    };
    const card = sessionCard(view({ status: "done" }), done);
    const rendered = json(card.blocks);

    expect(card.blocks.length).toBeGreaterThan(5);
    expect(rendered).toContain("first paragraph");
    expect(rendered).toContain("last paragraph");
    expect(rendered.match(/Agent replied/g)).toHaveLength(1);
  });

  it("carries only the opaque ref", () => {
    const rendered = json(sessionCard(view({ status: "idle" }), record()).blocks);
    expect(rendered).toContain("ref123");
    expect(rendered).not.toContain("w1:t1");
  });
});

describe("sessionCard chrome", () => {
  const record = () => ({
    ref: "ref123",
    firstSeen: 0,
    ended: false,
    endedNotifiedAt: null,
    lastKnownPaneId: "w1:p1",
    agentKind: "claude",
    title: "fix auth",
    cwd: "/Users/dev/project",
    workspaceId: "w1",
    tabId: "w1:t1",
    lastStatus: "idle" as const,
  });

  it("summarises the agent for the notification line", () => {
    const card = sessionCard(view(), record());
    expect(card.text).toContain("claude");
    expect(card.text).toContain("blocked");
  });

  it("shows the directory and workspace", () => {
    const rendered = json(sessionCard(view(), record()).blocks);
    expect(rendered).toContain("/Users/dev/project");
    expect(rendered).toContain("project");
  });

  it("copes with a pane that has no cwd", () => {
    expect(json(sessionCard(view({ cwd: "" }), record()).blocks)).toContain("?");
  });
});

describe("responseSections", () => {
  it("keeps every escaped character and stays within Slack's section limit", () => {
    const response = `${"<>&".repeat(1_500)}\nfinal line`;
    const sections = responseSections(response);
    const text = sections.map((block) => (block.text as { text: string }).text);
    const joined = text.join("\n").replace("*Agent replied*\n", "").replaceAll("\n", "");

    expect(text.every((value) => value.length <= 3_000)).toBe(true);
    expect(joined).toBe(`${"&lt;&gt;&amp;".repeat(1_500)}final line`);
    expect(text.at(-1)).toContain("final line");
  });
});

describe("blockedPromptBlocks", () => {
  const detection = "Do you want to proceed?\n❯ 1. Yes\n  2. No";

  it("renders a button per option", () => {
    const blocks = blockedPromptBlocks(view(), detection);
    const rendered = json(blocks ?? []);
    expect(rendered).toContain("1. Yes");
    expect(rendered).toContain("2. No");
  });

  it("highlights the option under the cursor", () => {
    const blocks = blockedPromptBlocks(view(), detection) ?? [];
    const elements = (blocks[1] as { elements: Record<string, unknown>[] }).elements;
    expect(elements[0]?.style).toBe("primary");
    expect(elements[1]?.style).toBeUndefined();
  });

  it("returns nothing when the output is not a live menu", () => {
    // A missed menu costs a tap; a false positive shows dead buttons.
    expect(blockedPromptBlocks(view(), "just some numbered prose\n1. a\n2. b")).toBeNull();
  });

  it("packs ref and choice into the value", () => {
    const blocks = blockedPromptBlocks(view(), detection) ?? [];
    const elements = (blocks[1] as { elements: Record<string, unknown>[] }).elements;
    expect(elements[0]?.value).toBe("ref123:1");
  });
});

describe("parseMenuChoiceValue", () => {
  it("splits a well-formed value", () => {
    expect(parseMenuChoiceValue("ref123:2")).toEqual({ ref: "ref123", choice: "2" });
  });

  it("handles a ref that itself contains a colon", () => {
    expect(parseMenuChoiceValue("a:b:c:3")).toEqual({ ref: "a:b:c", choice: "3" });
  });

  it.each(["ref123:0", "ref123:10", "ref123:x", "ref123:", ":1", "nocolon", ""])(
    "refuses %o rather than sending it as a keypress",
    (value) => {
      expect(parseMenuChoiceValue(value)).toBeNull();
    },
  );
});

describe("viewFromPane", () => {
  it("falls back sensibly for a bare pane", () => {
    const result = viewFromPane(
      pane({ agent: null, terminal_title_stripped: null, title: null, cwd: null }),
      "r1",
      "ws",
      "idle",
    );
    expect(result.agent).toBe("agent");
    expect(result.title).toBe("(untitled)");
    expect(result.cwd).toBe("");
  });
});

describe("threadTitle", () => {
  it("leads with status, because that is what the timeline is scanned for", () => {
    const title = threadTitle({ status: "blocked", agent: "claude", label: "fix auth redirect" });
    expect(title.startsWith(GLYPH.blocked)).toBe(true);
    expect(title).toContain("claude");
    expect(title).toContain("fix auth redirect");
  });

  it("truncates a long task rather than letting Slack cut it anywhere", () => {
    const title = threadTitle({
      status: "working",
      agent: "claude",
      label: "a task with a really quite extravagantly long description attached to it",
    });
    expect(title.length).toBeLessThanOrEqual(52);
    expect(title.endsWith("…")).toBe(true);
  });

  it("collapses whitespace so a wrapped terminal title stays one line", () => {
    expect(threadTitle({ status: "idle", agent: "codex", label: "one\n  two" })).toContain(
      "one two",
    );
  });

  it("names an untitled agent rather than showing an empty row", () => {
    expect(threadTitle({ status: "idle", agent: "codex", label: "" })).toContain("untitled");
  });
});
