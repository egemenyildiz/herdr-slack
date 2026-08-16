import type { TailStatus } from "../herdr/events.js";
import type { AgentStatus, PaneInfo } from "../herdr/types.js";
import { escapeMrkdwn } from "./format.js";

export const GLYPH: Record<AgentStatus, string> = {
  blocked: "🔴",
  working: "⚙️",
  idle: "💤",
  done: "✅",
  unknown: "❔",
};

export interface HomeAgent {
  ref: string;
  terminalId: string;
  agent: string;
  title: string;
  cwd: string;
  status: AgentStatus;
  workspaceId: string;
  workspaceLabel: string;
  permalink?: string;
}

export interface HomeModel {
  instanceLabel: string;
  agents: HomeAgent[];
  herdr: TailStatus;
  slackConnected: boolean;
  syncedAgoMs: number | null;
}

type Block = Record<string, unknown>;

const section = (text: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text },
});

const divider = (): Block => ({ type: "divider" });

const context = (text: string): Block => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
});

const button = (
  text: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger",
  url?: string,
): Block => ({
  type: "button",
  text: { type: "plain_text", text, emoji: true },
  action_id: actionId,
  value,
  ...(style ? { style } : {}),
  ...(url ? { url } : {}),
});

// Slack rejects empty button `value` and rejects the entire Home view with it.
const openButton = (agent: HomeAgent): Block | undefined => {
  if (!agent.ref) return undefined;
  return agent.permalink
    ? button("Open", "home_open_session", agent.ref, undefined, agent.permalink)
    : button("Open", "home_open_session", agent.ref);
};

/** Slack rejects `accessory: undefined`, so the key has to be absent entirely. */
const withOpen = (block: Block, agent: HomeAgent): Block => {
  const accessory = openButton(agent);
  return accessory ? { ...block, accessory } : block;
};

export function needsYou(agents: HomeAgent[]): HomeAgent[] {
  return agents
    .filter((agent) => agent.status === "blocked" || agent.status === "done")
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "blocked" ? -1 : 1));
}

export function groupByWorkspace(agents: HomeAgent[]): Map<string, HomeAgent[]> {
  const groups = new Map<string, HomeAgent[]>();
  for (const agent of agents) {
    const key = agent.workspaceLabel || agent.workspaceId;
    const bucket = groups.get(key) ?? [];
    bucket.push(agent);
    groups.set(key, bucket);
  }
  return groups;
}

function livenessFooter(model: HomeModel): Block {
  if (!model.slackConnected) return context("⚠️ reconnecting to Slack…");
  if (model.herdr !== "connected") {
    return context("⚠️ herdr not connected — start it with `herdr`");
  }
  const ago = model.syncedAgoMs;
  const text =
    ago === null
      ? "synced"
      : ago < 2_000
        ? "synced just now"
        : `synced ${Math.round(ago / 1000)}s ago`;
  return context(text);
}

function emptyState(model: HomeModel): Block[] | null {
  if (model.herdr !== "connected") {
    return [
      section("*herdr is not running.*"),
      context(
        "Start it with `herdr`. This view will fill in on its own — nothing to restart here.",
      ),
    ];
  }
  if (model.agents.length === 0) {
    return [
      section("*No agents running.*"),
      context("Tap *＋ New agent* above, or start one in herdr and it will appear here."),
    ];
  }
  return null;
}

/** Slack rejects Home views with more than 100 blocks. */
export const MAX_HOME_BLOCKS = 100;
const RESERVED_BLOCKS = 6;

export function buildHome(model: HomeModel): Block[] {
  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `🐑 Herd · ${model.instanceLabel}`, emoji: true },
    },
    {
      type: "actions",
      elements: [
        button("⟳ Refresh", "home_refresh", "refresh"),
        button("＋ New agent", "home_new_agent", "new", "primary"),
      ],
    },
  ];

  const empty = emptyState(model);
  if (empty) return [...blocks, ...empty, divider(), livenessFooter(model)];

  const attention = needsYou(model.agents);
  if (attention.length > 0) {
    blocks.push(divider(), section(`*🔴 NEEDS YOU (${attention.length})*`));
    for (const agent of attention) {
      blocks.push(
        withOpen(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${GLYPH[agent.status]} *${escapeMrkdwn(agent.agent)}* · ${escapeMrkdwn(agent.title)}\n\`${escapeMrkdwn(agent.cwd)}\``,
            },
          },
          agent,
        ),
      );
    }
  }

  let hidden = 0;
  for (const [workspace, agents] of groupByWorkspace(model.agents)) {
    if (blocks.length + RESERVED_BLOCKS >= MAX_HOME_BLOCKS) {
      hidden += agents.length;
      continue;
    }
    blocks.push(
      divider(),
      section(`*${workspace}*  ·  ${agents.length} agent${agents.length === 1 ? "" : "s"}`),
    );
    for (const agent of agents) {
      if (blocks.length + RESERVED_BLOCKS >= MAX_HOME_BLOCKS) {
        hidden += 1;
        continue;
      }
      blocks.push(
        withOpen(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${GLYPH[agent.status]} \`${escapeMrkdwn(agent.agent)}\`  ${escapeMrkdwn(agent.title)}`,
            },
          },
          agent,
        ),
      );
    }
  }

  if (hidden > 0) {
    blocks.push(
      context(
        `… and ${hidden} more. Anything blocked is listed above; open the rest from the thread list in *Messages*.`,
      ),
    );
  }

  blocks.push(divider(), livenessFooter(model));
  return blocks;
}

export function agentFromPane(
  pane: PaneInfo,
  ref: string,
  workspaceLabel: string,
  status: AgentStatus,
  permalink?: string,
): HomeAgent {
  return {
    ref,
    terminalId: pane.terminal_id,
    agent: pane.agent ?? "agent",
    title: pane.terminal_title_stripped ?? pane.title ?? "(untitled)",
    cwd: pane.cwd ?? "",
    status,
    workspaceId: pane.workspace_id,
    workspaceLabel,
    ...(permalink ? { permalink } : {}),
  };
}
