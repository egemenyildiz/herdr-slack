/**
 * Primary / satellite coordination for one Slack app and many herdr sources.
 */

import { randomBytes } from "node:crypto";
import os from "node:os";
import type { InstanceConfig } from "../config/config.js";
import { configDir } from "../config/instance.js";
import type { EventTail, TailStatus } from "../herdr/events.js";
import type { SessionState } from "../herdr/state.js";
import type { SessionRegistry } from "../registry/registry.js";
import type { HomeAgent, HomeHerd } from "../slack/home.js";
import { agentFromPane } from "../slack/home.js";
import type { SessionController } from "../slack/session-controller.js";
import {
  HEARTBEAT_INTERVAL_MS,
  type HerdAgentSnapshot,
  type HerdCommand,
  type HerdHeartbeat,
  HerdRegistry,
  defaultHerdRegistryDir,
  deriveHerdId,
  encodeHerdRef,
} from "./herd-registry.js";

export type SlackRole = "primary" | "satellite";

export interface HerdBridgeDeps {
  config: InstanceConfig;
  instance: string;
  state: SessionState;
  tail: EventTail;
  registry: SessionRegistry;
  log: (line: string) => void;
  /** Override for tests. */
  registryDir?: string;
  herdId?: string;
}

export class HerdBridge {
  readonly herdId: string;
  readonly registry: HerdRegistry;
  #role: SlackRole = "satellite";
  #timer: NodeJS.Timeout | null = null;
  #commandTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #sessions: SessionController | null = null;

  constructor(private readonly deps: HerdBridgeDeps) {
    this.herdId = deps.herdId ?? deriveHerdId(deps.instance);
    const dir =
      deps.registryDir ?? deps.config.herdRegistryDir ?? defaultHerdRegistryDir(configDir());
    this.registry = new HerdRegistry(dir);
  }

  /** Called once Surfaces has constructed its SessionController. */
  attachSessions(sessions: SessionController): void {
    this.#sessions = sessions;
  }

  get role(): SlackRole {
    return this.#role;
  }

  /** Elect primary (Socket Mode owner) or fall back to satellite. */
  async elect(): Promise<SlackRole> {
    const won = await this.registry.claimOwnership({
      appId: this.deps.config.slack.appId,
      herdId: this.herdId,
      pid: process.pid,
    });
    this.#role = won ? "primary" : "satellite";
    this.deps.log(
      `herd ${this.herdId} is ${this.#role} for app ${this.deps.config.slack.appId} (registry ${this.registry.root})`,
    );
    return this.#role;
  }

  start(): void {
    this.#stopped = false;
    void this.#tick();
    this.#timer = setInterval(() => void this.#tick(), HEARTBEAT_INTERVAL_MS);
    this.#timer.unref?.();
    if (this.#role === "satellite") {
      this.#commandTimer = setInterval(() => void this.#drainCommands(), 750);
      this.#commandTimer.unref?.();
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#commandTimer) clearInterval(this.#commandTimer);
    this.#commandTimer = null;
    this.registry.removeHeartbeat(this.herdId);
  }

  /** Snapshot for Home: every live herd on this Slack app. */
  homeHerds(): HomeHerd[] {
    const peers = this.registry.listHeartbeats(this.deps.config.slack.appId);
    return peers.map((peer) => ({
      herdId: peer.herdId,
      label: peer.label || peer.instance,
      pid: peer.pid,
      instance: peer.instance,
      socketPath: peer.socketPath,
      herdrStatus: peer.herdrStatus,
      role: peer.role,
      hostname: peer.hostname,
      user: peer.user,
      agentCount: peer.agents.length,
      isLocal: peer.herdId === this.herdId,
      updatedAt: peer.updatedAt,
    }));
  }

  /** Agents across all herds, with Open values routed for foreign ones. */
  homeAgents(localAgents: HomeAgent[]): HomeAgent[] {
    const localIds = new Set(localAgents.map((a) => a.terminalId));
    const merged = [...localAgents];
    for (const peer of this.registry.listHeartbeats(this.deps.config.slack.appId)) {
      if (peer.herdId === this.herdId) continue;
      for (const agent of peer.agents) {
        if (localIds.has(agent.terminalId)) continue;
        merged.push({
          ref: agent.ref,
          actionValue: encodeHerdRef(peer.herdId, agent.ref, this.herdId),
          terminalId: agent.terminalId,
          agent: agent.agent,
          title: agent.title,
          cwd: agent.cwd,
          status: agent.status,
          workspaceId: "",
          workspaceLabel: agent.workspaceLabel,
          herdId: peer.herdId,
          herdLabel: peer.label || peer.instance,
          ...(agent.permalink ? { permalink: agent.permalink } : {}),
        });
      }
    }
    return merged;
  }

  forwardCommand(input: {
    op: HerdCommand["op"];
    herdId: string;
    ref: string;
    channel: string;
    userId: string;
    text?: string;
  }): string {
    const id = randomBytes(8).toString("hex");
    const command: HerdCommand = {
      id,
      op: input.op,
      herdId: input.herdId,
      ref: input.ref,
      channel: input.channel,
      userId: input.userId,
      createdAt: Date.now(),
      ...(input.text !== undefined ? { text: input.text } : {}),
    };
    this.registry.enqueueCommand(command);
    return id;
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    if (this.#role === "primary") {
      this.registry.renewOwnership(this.deps.config.slack.appId, this.herdId, process.pid);
      // Re-elect if we somehow lost ownership (another primary came up fresher).
      const owner = this.registry.readOwnership(this.deps.config.slack.appId);
      if (owner && owner.herdId !== this.herdId) {
        this.deps.log(`lost Slack ownership to ${owner.herdId}; becoming satellite`);
        this.#role = "satellite";
      }
    } else {
      const won = await this.registry.claimOwnership({
        appId: this.deps.config.slack.appId,
        herdId: this.herdId,
        pid: process.pid,
      });
      if (won && this.#role === "satellite") {
        this.deps.log("claimed Slack ownership; restart daemon to become primary Socket Mode");
        // Stay satellite until restart — flipping Socket Mode live is unsafe.
      }
    }

    const agents = this.#snapshotAgents();
    const heartbeat: HerdHeartbeat = {
      herdId: this.herdId,
      label: this.deps.config.label || this.deps.instance,
      pid: process.pid,
      instance: this.deps.instance,
      socketPath: this.deps.config.herdrSocketPath,
      appId: this.deps.config.slack.appId,
      teamId: this.deps.config.slack.teamId,
      herdrStatus: this.deps.tail.status as TailStatus,
      agents,
      updatedAt: Date.now(),
      role: this.#role,
      hostname: os.hostname(),
      user: os.userInfo().username,
    };
    this.registry.writeHeartbeat(heartbeat);
  }

  #snapshotAgents(): HerdAgentSnapshot[] {
    const { state, registry } = this.deps;
    const out: HerdAgentSnapshot[] = [];
    for (const pane of state.agentPanes()) {
      const record = registry.get(pane.terminal_id);
      const status = state.statusOf(pane.terminal_id) ?? pane.agent_status ?? "unknown";
      const workspace = state.workspaces.get(pane.workspace_id);
      const agent = agentFromPane(
        pane,
        record?.ref ?? "",
        workspace?.label ?? pane.workspace_id,
        status,
        record?.slackPermalink,
      );
      out.push({
        ref: agent.ref,
        terminalId: agent.terminalId,
        agent: agent.agent,
        title: agent.title,
        cwd: agent.cwd,
        status: agent.status,
        workspaceLabel: agent.workspaceLabel,
        ...(agent.permalink ? { permalink: agent.permalink } : {}),
      });
      if (out.length >= 40) break;
    }
    return out;
  }

  async #drainCommands(): Promise<void> {
    if (this.#stopped || this.#role !== "satellite") return;
    for (const command of this.registry.listCommands(this.herdId)) {
      try {
        const message = await this.#runCommand(command);
        this.registry.completeCommand(command, {
          ok: !message,
          ...(message ? { message } : {}),
          completedAt: Date.now(),
        });
      } catch (error) {
        this.registry.completeCommand(command, {
          ok: false,
          message: (error as Error).message,
          completedAt: Date.now(),
        });
      }
    }
  }

  async #runCommand(command: HerdCommand): Promise<string | undefined> {
    const sessions = this.#sessions;
    if (!sessions) return "Session controller not ready.";
    const terminalId = this.deps.registry.terminalForRef(command.ref);
    if (!terminalId) return "That agent is no longer on this herd.";

    switch (command.op) {
      case "open_session": {
        const outcome = await sessions.openSession(terminalId, command.channel);
        return outcome.ok ? undefined : outcome.message;
      }
      case "refresh": {
        await sessions.refreshResponse(terminalId);
        return undefined;
      }
      case "end_session": {
        const outcome = await sessions.closeTerminal(terminalId);
        return outcome.ok ? undefined : outcome.message;
      }
      case "prompt": {
        if (!command.text) return "Missing prompt.";
        const baseline = await sessions.captureBaseline(terminalId);
        const outcome = await sessions.prompt(terminalId, command.text);
        if (!outcome.ok) return outcome.message;
        this.deps.registry.startTurn(terminalId, command.text, baseline);
        this.deps.registry.save();
        void sessions.updateCard(terminalId);
        return undefined;
      }
      case "menu_choice": {
        // Satellite menu choices are handled by the session controller path when
        // we add key send; for now refuse clearly.
        return "Menu choices on a satellite herd are not supported yet.";
      }
      default:
        return "Unknown command.";
    }
  }
}
