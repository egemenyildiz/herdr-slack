import { buttonLabel, parseMenu, renderableChoices } from "../agents/menu.js";
import type { ContentMode } from "../config/config.js";
import { menuChoiceKeys } from "../herdr/keys.js";
import type { AgentStatus, PaneInfo } from "../herdr/types.js";
import type { SessionRecord, SessionTurn } from "../registry/registry.js";
import { escapeMrkdwn, summaryLine } from "./format.js";
import { GLYPH } from "./home.js";

type Block = Record<string, unknown>;
const SECTION_TEXT_LIMIT = 2_900;
const MAX_RESPONSE_BLOCKS = 44;

/**
 * Split escaped mrkdwn at line boundaries without splitting an HTML entity.
 * Slack caps section text at 3,000 characters; the margin leaves room for the
 * "Agent replied" heading in the first block.
 */
export function responseSections(response: string, heading = "*Agent replied*"): Block[] {
  const chunks: string[] = [];
  let current = "";

  const append = (piece: string): void => {
    if (current && current.length + 1 + piece.length <= SECTION_TEXT_LIMIT) {
      current += `\n${piece}`;
      return;
    }
    if (current) chunks.push(current);
    current = piece;
  };

  for (const line of response.split("\n")) {
    let escapedLine = "";
    for (const character of line) {
      const escapedCharacter = escapeMrkdwn(character);
      if (escapedLine.length + escapedCharacter.length > SECTION_TEXT_LIMIT) {
        append(escapedLine);
        escapedLine = escapedCharacter;
      } else {
        escapedLine += escapedCharacter;
      }
    }
    append(escapedLine);
  }
  if (current || chunks.length === 0) chunks.push(current);

  // The herdr pane read is bounded well below this, but enforce Slack's
  // 50-block payload limit instead of sending an invalid card.
  const visible = chunks.slice(0, MAX_RESPONSE_BLOCKS);
  return visible.map((chunk, index) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: index === 0 ? `${heading}\n${chunk}` : chunk,
    },
  }));
}

/** Actions a session thread offers. Each maps to one protocol-19 primitive. */
export const SESSION_ACTIONS = {
  reply: "session_reply",
  refresh: "session_refresh",
  history: "session_history",
  historyPage: "session_history_page",
  end: "session_end",
  menuChoice: "session_menu_choice",
} as const;

export interface SessionView {
  ref: string;
  agent: string;
  title: string;
  cwd: string;
  status: AgentStatus;
  workspaceLabel: string;
  tabId: string;
  ended?: boolean;
  /**
   * When false, omit every interactive control. Block Kit has no disabled
   * buttons — a read-only banner is the only honest offline surface.
   * Omitted means connected (tests and ended cards).
   */
  herdrConnected?: boolean;
}

export function sendsTerminalText(mode: ContentMode): boolean {
  return mode === "full";
}

export function isExcluded(cwd: string, excludePaths: string[]): boolean {
  if (!cwd) return false;
  return excludePaths.some((prefix) => prefix && cwd.startsWith(prefix));
}

export function threadTitle(input: { status: AgentStatus; agent: string; label: string }): string {
  const label = (input.label || "untitled").replace(/\s+/g, " ").trim();
  const head = `${GLYPH[input.status]} ${input.agent} · `;
  const room = Math.max(12, 50 - head.length);
  return `${head}${label.length > room ? `${label.slice(0, room - 1)}…` : label}`;
}

const button = (
  text: string,
  actionId: string,
  value: string,
  extra: Record<string, unknown> = {},
): Block => ({
  type: "button",
  text: { type: "plain_text", text, emoji: true },
  action_id: actionId,
  value,
  ...extra,
});

/** Slack's confirm dialog, for the controls that can lose work. */
const confirm = (title: string, body: string, ok: string): Record<string, unknown> => ({
  title: { type: "plain_text", text: title },
  text: { type: "mrkdwn", text: body },
  confirm: { type: "plain_text", text: ok },
  deny: { type: "plain_text", text: "Cancel" },
});

/** Say what "End session" really does: it destroys the terminal, not just the card. */
const END_CONFIRM_BODY =
  "This *closes the terminal* in your editor, ending the agent and losing anything unsaved. The Slack card becomes read-only.";

/** The agent's state in words, plus what it means for the reader. */
export function statusLine(status: AgentStatus, latest?: SessionTurn): string {
  if (latest?.status === "working") {
    return `${GLYPH.working} *Working* on your reply — this card updates itself when it lands.`;
  }
  switch (status) {
    case "working":
      return `${GLYPH.working} *Working* — no need to wait here, you will be notified.`;
    case "blocked":
      return `${GLYPH.blocked} *Waiting on you* — it is asking a question.`;
    case "done":
      return `${GLYPH.done} *Finished* its last turn.`;
    case "idle":
      return `${GLYPH.idle} *Idle* — ready for a reply.`;
    default:
      return `${GLYPH.unknown} *State unknown* — herdr has not reported on this agent yet.`;
  }
}

export function sessionCard(
  view: SessionView,
  record: SessionRecord,
  blockedBlocks: Block[] = [],
): { text: string; blocks: Block[] } {
  const text = summaryLine(view.agent, view.status, view.title);
  const latest = record.turns?.at(-1);
  const prompt = latest?.prompt ?? "_No prompt sent from Slack yet._";
  const response =
    latest?.response ??
    record.latestResponse ??
    (latest?.status === "working" ? "_Working…_" : "_Tap Refresh to read the latest response._");
  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${GLYPH[view.status]} *${escapeMrkdwn(view.agent)}* · ${escapeMrkdwn(view.title)}\n\`${escapeMrkdwn(view.cwd || "?")}\`  ·  ${escapeMrkdwn(view.workspaceLabel)}`,
      },
    },
    // A glyph alone is not a state: say it in words, and say what it means for
    // the reader, so nobody has to learn the icons to know whether to wait.
    { type: "context", elements: [{ type: "mrkdwn", text: statusLine(view.status, latest) }] },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*You asked*\n${escapeMrkdwn(prompt).slice(0, 1_200)}` },
    },
    ...responseSections(response),
  ];

  if (view.ended) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "⚪️ *Session ended.* This card is read-only." }],
    });
    return { text, blocks };
  }

  // herdr down (or the machine asleep when we last could talk to it): strip
  // every control. Stale Reply/End buttons would only produce opaque Slack ⚠️.
  if (view.herdrConnected === false) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "⚠️ *Computer unreachable.* Wake it and keep herdr running — Reply, Refresh, Earlier, and End session stay off until then.",
        },
      ],
    });
    return { text, blocks };
  }

  if (blockedBlocks.length > 0) blocks.push(...blockedBlocks);

  blocks.push({
    type: "actions",
    elements:
      view.status === "blocked" || view.status === "working" || latest?.status === "working"
        ? [
            button("Refresh", SESSION_ACTIONS.refresh, view.ref),
            button("Earlier", SESSION_ACTIONS.history, view.ref),
            button("End session", SESSION_ACTIONS.end, view.ref, {
              style: "danger",
              confirm: confirm("End this session?", END_CONFIRM_BODY, "Close terminal"),
            }),
          ]
        : [
            button("Reply", SESSION_ACTIONS.reply, view.ref, { style: "primary" }),
            button("Refresh", SESSION_ACTIONS.refresh, view.ref),
            button("Earlier", SESSION_ACTIONS.history, view.ref),
            button("End session", SESSION_ACTIONS.end, view.ref, {
              style: "danger",
              confirm: confirm("End this session?", END_CONFIRM_BODY, "Close terminal"),
            }),
          ],
  });

  return {
    text,
    blocks,
  };
}

export function blockedPromptBlocks(view: SessionView, detection: string): Block[] | null {
  const choices = parseMenu(detection);
  if (!choices) return null;
  return [
    { type: "section", text: { type: "mrkdwn", text: "*This agent is waiting on you:*" } },
    {
      type: "actions",
      elements: renderableChoices(choices).map((choice) =>
        // ref:digit — digit is re-validated before send_keys.
        button(
          buttonLabel(choice),
          `${SESSION_ACTIONS.menuChoice}_${choice.number}`,
          `${view.ref}:${choice.number}`,
          {
            ...(choice.highlighted ? { style: "primary" } : {}),
          },
        ),
      ),
    },
  ];
}

/** Split a menu-choice action value back into its parts, safely. */
export function parseMenuChoiceValue(value: string): { ref: string; choice: string } | null {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const ref = value.slice(0, separator);
  const choice = value.slice(separator + 1);
  try {
    menuChoiceKeys(choice);
  } catch {
    return null;
  }
  return { ref, choice };
}

export function viewFromPane(
  pane: PaneInfo,
  ref: string,
  workspaceLabel: string,
  status: AgentStatus,
  ended = false,
): SessionView {
  return {
    ...(ended ? { ended } : {}),
    ref,
    agent: pane.agent ?? "agent",
    title: pane.terminal_title_stripped ?? pane.title ?? "(untitled)",
    cwd: pane.cwd ?? "",
    status,
    workspaceLabel,
    tabId: pane.tab_id,
  };
}
