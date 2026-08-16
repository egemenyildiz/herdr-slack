import { HerdrClient } from "../herdr/client.js";
import { EventTail } from "../herdr/events.js";
import { SessionState } from "../herdr/state.js";
import type { AgentStatus, PaneInfo } from "../herdr/types.js";

const GLYPH: Record<AgentStatus, string> = {
  blocked: "🔴",
  working: "⚙️ ",
  idle: "💤",
  done: "✅",
  unknown: "❔",
};

function render(state: SessionState, tailStatus: string): string {
  const lines: string[] = [];
  lines.push(`\x1b[1mherd\x1b[0m  ·  herdr: ${tailStatus}`);
  lines.push("─".repeat(72));

  const byWorkspace = new Map<string, PaneInfo[]>();
  for (const pane of state.agentPanes()) {
    const bucket = byWorkspace.get(pane.workspace_id) ?? [];
    bucket.push(pane);
    byWorkspace.set(pane.workspace_id, bucket);
  }

  if (byWorkspace.size === 0) {
    lines.push(
      tailStatus === "connected"
        ? "  no agents running"
        : "  waiting for herdr — start it with `herdr`",
    );
    return lines.join("\n");
  }

  for (const [workspaceId, panes] of byWorkspace) {
    const label = state.workspaces.get(workspaceId)?.label ?? workspaceId;
    lines.push(`\n▾ ${label}  (${panes.length})`);
    for (const pane of panes) {
      const title = pane.terminal_title_stripped ?? pane.title ?? "";
      const status = state.statusOf(pane.terminal_id) ?? pane.agent_status;
      lines.push(
        `    ${GLYPH[status]} ${(pane.agent ?? "?").padEnd(8)} ${title.slice(0, 44).padEnd(44)} ${pane.pane_id}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Live dashboard driven purely by the event subscription — no polling.
 *
 * This is M0's proof that the tail and projection are correct before any Slack
 * code exists: open a tab, start an agent, block it, move a pane, and watch the
 * display follow.
 */
export async function devTail(socketPath?: string): Promise<number> {
  const client = new HerdrClient(socketPath);
  const state = new SessionState();
  const tail = new EventTail(client, state);

  let tailStatus = "connecting";
  let dirty = true;

  tail.on("status", ({ status }) => {
    tailStatus = status;
    dirty = true;
  });
  state.on("changed", () => {
    dirty = true;
  });
  state.on("transition", (t) => {
    process.stderr.write(`\n  → ${t.terminalId} ${t.from ?? "?"} → ${t.to}\n`);
  });

  tail.start();

  const timer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    process.stdout.write(`\x1b[2J\x1b[H${render(state, tailStatus)}\n`);
  }, 200);

  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  clearInterval(timer);
  tail.stop();
  state.dispose();
  return 0;
}
