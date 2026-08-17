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
  /** Button value — may be herd-encoded for foreign agents. */
  actionValue: string;
  terminalId: string;
  agent: string;
  title: string;
  cwd: string;
  status: AgentStatus;
  workspaceId: string;
  workspaceLabel: string;
  permalink?: string;
  /** Which herd this agent belongs to (for grouping / display). */
  herdId: string;
  herdLabel: string;
}

export interface HomeHerd {
  herdId: string;
  label: string;
  pid: number;
  instance: string;
  socketPath: string;
  herdrStatus: TailStatus;
  role: "primary" | "satellite";
  hostname: string;
  user: string;
  agentCount: number;
  isLocal: boolean;
  updatedAt: number;
}

export interface HomeModel {
  /** All live herds for this Slack app, including this daemon. */
  herds: HomeHerd[];
  localHerdId: string;
  agents: HomeAgent[];
  herdr: TailStatus;
  slackConnected: boolean;
  /**
   * ms since herdr state was last reconciled for *this* daemon.
   * Refresh bumps this; it is not "time since Home was published".
   */
  herdrSyncedAgoMs: number | null;
  /** When Home itself was last published (informational). */
  role: "primary" | "satellite";
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
  if (!agent.actionValue) return undefined;
  return agent.permalink
    ? button("Open", "home_open_session", agent.actionValue, undefined, agent.permalink)
    : button("Open", "home_open_session", agent.actionValue);
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

function herdLine(herd: HomeHerd): string {
  const status =
    herd.herdrStatus === "connected"
      ? "connected"
      : herd.herdrStatus === "waiting"
        ? "herdr down"
        : "connecting";
  const where = herd.isLocal ? "this daemon" : `${herd.user}@${herd.hostname}`;
  const role = herd.role === "primary" ? "primary" : "satellite";
  const socket = shortenPath(herd.socketPath);
  // Same profile label on two herds is ambiguous — pid + host/user disambiguates.
  return (
    `*${escapeMrkdwn(herd.label || herd.instance)}* · pid \`${herd.pid}\` · ${role}\n` +
    `\`${escapeMrkdwn(socket)}\` · ${status} · ${herd.agentCount} agent${herd.agentCount === 1 ? "" : "s"} · ${escapeMrkdwn(where)}`
  );
}

function shortenPath(socketPath: string): string {
  const home = process.env.HOME;
  if (home && socketPath.startsWith(home)) return `~${socketPath.slice(home.length)}`;
  return socketPath;
}

function livenessFooter(model: HomeModel): Block {
  if (!model.slackConnected) return context("⚠️ reconnecting to Slack…");
  if (model.role === "satellite") {
    return context("satellite — Home is published by the primary daemon for this Slack app");
  }
  if (model.herdr !== "connected") {
    return context("⚠️ this herd's herdr is unreachable — wake the machine and run `herdr`");
  }
  const ago = model.herdrSyncedAgoMs;
  const text =
    ago === null
      ? "herdr not synced yet — tap Refresh"
      : ago < 2_000
        ? "herdr synced just now"
        : `herdr synced ${Math.round(ago / 1000)}s ago · Refresh re-syncs`;
  return context(text);
}

function emptyState(model: HomeModel): Block[] | null {
  const foreignAgents = model.agents.filter(
    (agent) => agent.herdId && agent.herdId !== model.localHerdId,
  );
  // Local herdr down and nothing from peers → do not render a stale local list.
  if (model.herdr !== "connected" && foreignAgents.length === 0) {
    return [
      section("*Your computer is not reachable.*"),
      context(
        "Wake the machine and start herdr (`herdr`). Phone control only works while the computer is awake — sleep freezes the daemon. This view fills in on its own once herdr reconnects.",
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
const RESERVED_BLOCKS = 8;

function herdsHeader(model: HomeModel): Block[] {
  if (model.herds.length === 0) return [];
  const blocks: Block[] = [divider(), section("*Herds*")];
  for (const herd of model.herds) blocks.push(section(herdLine(herd)));
  return blocks;
}

function attentionBlocks(model: HomeModel): Block[] {
  const attention = needsYou(model.agents);
  if (attention.length === 0) return [];
  const blocks: Block[] = [divider(), section(`*🔴 NEEDS YOU (${attention.length})*`)];
  for (const agent of attention) {
    blocks.push(
      withOpen(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${GLYPH[agent.status]} *${escapeMrkdwn(agent.agent)}* · ${escapeMrkdwn(agent.title)}\n\`${escapeMrkdwn(agent.cwd)}\`${herdSuffix(agent, model)}`,
          },
        },
        agent,
      ),
    );
  }
  return blocks;
}

function workspaceBlocks(
  model: HomeModel,
  startLength: number,
): { blocks: Block[]; hidden: number } {
  const blocks: Block[] = [];
  let hidden = 0;
  for (const [workspace, agents] of groupByWorkspace(model.agents)) {
    if (startLength + blocks.length + RESERVED_BLOCKS >= MAX_HOME_BLOCKS) {
      hidden += agents.length;
      continue;
    }
    blocks.push(
      divider(),
      section(`*${workspace}*  ·  ${agents.length} agent${agents.length === 1 ? "" : "s"}`),
    );
    for (const agent of agents) {
      if (startLength + blocks.length + RESERVED_BLOCKS >= MAX_HOME_BLOCKS) {
        hidden += 1;
        continue;
      }
      blocks.push(
        withOpen(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${GLYPH[agent.status]} \`${escapeMrkdwn(agent.agent)}\`  ${escapeMrkdwn(agent.title)}${herdSuffix(agent, model)}`,
            },
          },
          agent,
        ),
      );
    }
  }
  return { blocks, hidden };
}

export function buildHome(model: HomeModel): Block[] {
  const localUp = model.herdr === "connected";
  const title =
    model.herds.length <= 1
      ? `🐑 Herd · ${model.herds[0]?.label || "herdr"}`
      : `🐑 Herds · ${model.herds.length}`;

  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: title, emoji: true },
    },
    {
      type: "actions",
      elements: localUp
        ? [
            button("⟳ Refresh", "home_refresh", "refresh"),
            button("＋ New agent", "home_new_agent", "new", "primary"),
          ]
        : [button("⟳ Refresh", "home_refresh", "refresh")],
    },
    ...herdsHeader(model),
  ];

  const empty = emptyState(model);
  if (empty) return [...blocks, ...empty, divider(), livenessFooter(model)];

  blocks.push(...attentionBlocks(model));
  const { blocks: workspaces, hidden } = workspaceBlocks(model, blocks.length);
  blocks.push(...workspaces);

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

function herdSuffix(agent: HomeAgent, model: HomeModel): string {
  if (model.herds.length <= 1 || agent.herdId === model.localHerdId) return "";
  return `\n_${escapeMrkdwn(agent.herdLabel)}_`;
}

export function agentFromPane(
  pane: PaneInfo,
  ref: string,
  workspaceLabel: string,
  status: AgentStatus,
  permalink?: string,
  herd?: { herdId: string; herdLabel: string; actionValue: string },
): HomeAgent {
  return {
    ref,
    actionValue: herd?.actionValue ?? ref,
    terminalId: pane.terminal_id,
    agent: pane.agent ?? "agent",
    title: pane.terminal_title_stripped ?? pane.title ?? "(untitled)",
    cwd: pane.cwd ?? "",
    status,
    workspaceId: pane.workspace_id,
    workspaceLabel,
    herdId: herd?.herdId ?? "",
    herdLabel: herd?.herdLabel ?? "",
    ...(permalink ? { permalink } : {}),
  };
}
