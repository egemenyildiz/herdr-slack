import type {
  AgentStatus,
  PaneInfo,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "../../src/herdr/types.js";

let seq = 0;

export function pane(overrides: Partial<PaneInfo> & { terminal_id?: string } = {}): PaneInfo {
  const n = ++seq;
  return {
    pane_id: `w1:p${n}`,
    terminal_id: `term_${n}`,
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: false,
    agent_status: "working",
    revision: 1,
    agent: "claude",
    cwd: "/Users/dev/project",
    terminal_title_stripped: "a task",
    ...overrides,
  };
}

export function workspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    workspace_id: "w1",
    label: "project",
    number: 1,
    focused: true,
    agent_status: "working",
    active_tab_id: "w1:t1",
    tab_count: 1,
    pane_count: 1,
    ...overrides,
  };
}

export function tab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    tab_id: "w1:t1",
    workspace_id: "w1",
    label: "1",
    number: 1,
    focused: true,
    agent_status: "working",
    pane_count: 1,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    version: "0.8.0",
    protocol: 19,
    workspaces: [workspace()],
    tabs: [tab()],
    panes: [],
    agents: [],
    ...overrides,
  };
}

export function withStatus(source: PaneInfo, agent_status: AgentStatus): PaneInfo {
  return { ...source, agent_status, revision: source.revision + 1 };
}
