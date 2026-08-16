import { autoModeFor, findEntry, loadCatalog } from "../agents/catalog.js";
import { readLastLaunch, writeLastLaunch } from "../agents/last-launch.js";
import { launchAgent, sanitizeAgentName } from "../agents/launcher.js";
import type { InstanceConfig } from "../config/config.js";
import type { RateBudget } from "../daemon/budget.js";
import type { HerdrClient } from "../herdr/client.js";
import type { EventTail } from "../herdr/events.js";
import type { SessionState } from "../herdr/state.js";
import type { AgentStatus } from "../herdr/types.js";
import { type SessionRegistry, sweepOrphans } from "../registry/registry.js";
import { escapeMrkdwn } from "./format.js";
import { ActionThrottle, type GuardDeps, authorizeAction, checkInbound } from "./guards.js";
import { GLYPH, type HomeAgent, agentFromPane, buildHome } from "./home.js";
import { resolveThreadPermalink } from "./links.js";
import {
  BLOCK_IDS,
  MODAL_IDS,
  buildHistoryModal,
  buildNewAgentModal,
  buildReplyModal,
  parseNewAgentSubmission,
  parseReplySubmission,
  skeletonModal,
} from "./modals.js";
import { SessionController } from "./session-controller.js";
import { SESSION_ACTIONS } from "./session.js";
import type { SlackTransport, ViewSubmitResult } from "./transport.js";
import { type InboundContext, inboundMessageDedupeKey } from "./transport.js";

/** Keep the reply modal open, with the reason under the text box. */
const replyError = (message: string): ViewSubmitResult => ({
  errors: { [BLOCK_IDS.reply]: message },
});

/** Default wait before treating a missing pane.agent as a quit (not a flap). */
export const AGENT_GONE_MS = 10_000;

/** Cursor reports idle between tool calls; wait before posting thread activity. */
export const CURSOR_IDLE_ACTIVITY_MS = 15_000;

/** Debounce Home republish after state changes. */
const HOME_DEBOUNCE_MS = 5_000;

interface NoticeTarget {
  userId?: string | undefined;
  threadTs?: string | undefined;
}

export interface SurfacesDeps {
  config: InstanceConfig;
  instance: string;
  transport: SlackTransport;
  state: SessionState;
  tail: EventTail;
  registry: SessionRegistry;
  budget: RateBudget;
  client: HerdrClient;
  /** How long to wait for a menu keypress to be acknowledged. */
  ackTimeoutMs?: number;
  /** Wait after pane.agent clears before posting "Agent exited". Defaults to AGENT_GONE_MS. */
  agentGoneMs?: number;
  /** Wait after cursor goes idle before posting activity. Defaults to CURSOR_IDLE_ACTIVITY_MS. */
  cursorIdleActivityMs?: number;
  log: (line: string) => void;
}

/** Wires herdr state to Slack surfaces; inbound actions go through guards first. */
export class Surfaces {
  #homeTimer: NodeJS.Timeout | null = null;
  /** userId → DM channel, for interactions that arrive without one. */
  #dmChannels = new Map<string, string>();
  /** Who acted most recently, so a note can be addressed even deep in a helper. */
  #lastActor = "";
  #lastSyncAt: number | null = null;
  #guards: GuardDeps;
  #sessions: SessionController;
  /** terminalId → timer waiting to confirm the agent actually quit. */
  #agentGoneTimers = new Map<string, NodeJS.Timeout>();
  /** terminalId → timer waiting to confirm an idle turn is actually settled. */
  #cursorIdleTimers = new Map<string, NodeJS.Timeout>();
  /** Slack message deliveries already handled (`channel:ts` or event id). */
  #seenMessageKeys = new Set<string>();

  constructor(private readonly deps: SurfacesDeps) {
    this.#sessions = new SessionController({
      config: deps.config,
      client: deps.client,
      state: deps.state,
      registry: deps.registry,
      transport: deps.transport,
      log: deps.log,
    });
    this.#guards = {
      config: deps.config,
      throttle: new ActionThrottle(),
      resolveRef: (ref) => deps.registry.terminalForRef(ref),
      isLive: (terminalId) => deps.state.paneByTerminal(terminalId) !== undefined,
    };
  }

  start(): void {
    const { transport, state, tail, registry, log } = this.deps;

    transport.onHomeOpened(async ({ ctx }) => {
      const decision = checkInbound(this.#guards, ctx);
      if (!decision.allowed) {
        log(`home_opened denied: ${decision.reason}`);
        return;
      }
      await this.publishHome(ctx.userId);
    });

    transport.onAction(async ({ ctx, actionId, value, triggerId, viewId }) => {
      // Home actions use literal values, not refs — handle before ref resolution.
      this.#lastActor = ctx.userId;
      if (actionId === "home_refresh" || actionId === "home_new_agent") {
        const decision = checkInbound(this.#guards, ctx);
        if (!decision.allowed) {
          log(`action ${actionId} denied: ${decision.reason}`);
          return;
        }
        if (actionId === "home_refresh") {
          await this.publishHome(ctx.userId);
        } else {
          await this.#openNewAgentModal(triggerId);
        }
        return;
      }
      // Menu choices pack ref:digit; extract the ref before authorisation.
      const refForAuth = SessionController.isMenuChoiceAction(actionId)
        ? (SessionController.decodeMenuChoice(value)?.ref ?? "")
        : value;
      const channel = await this.#replyChannel(ctx);
      const result = authorizeAction(this.#guards, ctx, refForAuth);
      if (!result.decision.allowed) {
        log(`action ${actionId} denied: ${result.decision.reason}`);
        await this.#ephemeral(channel, result.decision.message ?? "Not allowed.");
        return;
      }
      log(`action ${actionId} terminal=${result.terminalId} actor=${ctx.userId}`);
      await this.#dispatch(actionId, result.terminalId ?? "", value, channel, triggerId, viewId);
    });

    // Bare DMs have no thread target; treat them as commands, not prompts.
    transport.onMessage(async ({ ctx, text }) => {
      this.#lastActor = ctx.userId;
      const decision = checkInbound(this.#guards, ctx);
      if (!decision.allowed) {
        log(`message denied: ${decision.reason}`);
        return;
      }
      if (!ctx.threadTs) {
        if (!this.#markMessageSeen(ctx)) {
          log(`duplicate bare message ignored ts=${ctx.ts ?? ctx.eventId ?? "?"}`);
          return;
        }
        await this.#handleBareMessage(ctx.channel, ctx.userId, text);
        return;
      }
      if (!this.#markMessageSeen(ctx)) return;
      const terminalId = this.terminalForThread(ctx.threadTs);
      if (!terminalId) {
        await this.#ephemeral(
          ctx.channel,
          "I do not recognise this thread — open a session first.",
          {
            userId: ctx.userId,
            threadTs: ctx.threadTs,
          },
        );
        return;
      }
      await this.#ephemeral(
        ctx.channel,
        "Use *Reply* on the session card so prompts stay attached to a single remote turn.",
        { userId: ctx.userId, threadTs: ctx.threadTs },
      );
    });

    // Debounce Home refresh on structural changes to protect the write budget.
    state.on("changed", () => {
      void this.#reapDeadSessions();
      this.#scheduleHome();
    });
    tail.on("ready", () => {
      this.#lastSyncAt = Date.now();
      this.reconcileSessions();
      this.#scheduleHome();
    });
    tail.on("status", ({ status }) => {
      if (status === "connected") this.#lastSyncAt = Date.now();
      this.#scheduleHome();
    });
    transport.onConnectionChange((connected) => {
      log(`slack: ${connected ? "connected" : "disconnected"}`);
      if (connected) this.#scheduleHome();
    });

    transport.onViewSubmit(async ({ ctx, callbackId, view, privateMetadata }) => {
      const decision = checkInbound(this.#guards, ctx);
      if (!decision.allowed) {
        log(`view submit denied: ${decision.reason}`);
        return;
      }
      if (callbackId === MODAL_IDS.newAgent) {
        await this.#launchFromModal(ctx.userId, await this.#replyChannel(ctx), view);
        return;
      }
      if (callbackId === MODAL_IDS.reply) {
        const terminalId = this.deps.registry.terminalForRef(privateMetadata ?? "");
        const prompt = parseReplySubmission(view);
        if (!terminalId || !prompt) {
          log("reply modal rejected: missing target or prompt");
          return replyError("That session is no longer available — reopen it from Home.");
        }
        const error = await this.#submitTurn(terminalId, prompt);
        if (error) return replyError(error);
      }
      return;
    });

    // Post settled agent output to the session thread on status transition.
    state.on("transition", ({ terminalId, to, from }) => {
      void this.#onTransition(terminalId, to, from);
    });

    // Close the session thread when the pane is gone.
    state.on("paneGone", ({ terminalId }) => {
      void this.#endSession(terminalId);
    });

    registry.load();
  }

  /**
   * Keep the session card current as its agent moves.
   *
   * This runs for any session with a card, not only Slack-driven turns, so work
   * done at the keyboard still lands in the card, in "Earlier", and in the ping.
   * The only new message is the one-per-turn reply notice, claimed against the
   * turn id — an earlier version keyed off status alone and announced "Finished"
   * on a loop.
   */
  async #onTransition(terminalId: string, to: AgentStatus, from?: AgentStatus): Promise<void> {
    const record = this.deps.registry.get(terminalId);
    if (!record?.slackThreadTs || !record.slackChannel || record.ended) return;

    if (to === "working" || to === "unknown") {
      if (to === "working") this.#clearCursorIdleTimer(terminalId);
      if (this.deps.registry.activeTurn(terminalId)) await this.#sessions.updateCard(terminalId);
      return;
    }
    if (from === undefined) return;

    await this.#sessions.retitle(terminalId);
    this.#clearCursorIdleTimer(terminalId);
    if (to === "idle") {
      this.#scheduleCursorIdlePost(terminalId);
      return;
    }
    if (to === "done" || to === "blocked") {
      await this.#sessions.refreshResponse(terminalId, to);
    }
  }

  /** Close threads whose agent exited but the pane remains. */
  async #reapDeadSessions(): Promise<void> {
    const { state, registry } = this.deps;
    for (const [terminalId, record] of registry.entries()) {
      if (!record.slackThreadTs) continue;
      const pane = state.paneByTerminal(terminalId);
      if (pane?.agent) {
        this.#clearAgentGoneTimer(terminalId);
        if (record.ended) {
          await this.#sessions.reviveIfLive(terminalId);
          registry.save();
        }
        continue;
      }
      if (record.ended) continue;
      if (!pane) {
        this.#clearAgentGoneTimer(terminalId);
        continue;
      }
      this.#scheduleAgentGoneTimer(terminalId);
    }
  }

  #agentGoneDelayMs(): number {
    return this.deps.agentGoneMs ?? AGENT_GONE_MS;
  }

  #cursorIdleDelayMs(): number {
    return this.deps.cursorIdleActivityMs ?? CURSOR_IDLE_ACTIVITY_MS;
  }

  /** Drop Slack retries and duplicate deliveries of the same message ts. */
  #markMessageSeen(ctx: InboundContext): boolean {
    if (ctx.retryNum !== undefined && ctx.retryNum > 0) return false;
    const key = inboundMessageDedupeKey(ctx);
    if (!key) return true;
    if (this.#seenMessageKeys.has(key)) return false;
    this.#seenMessageKeys.add(key);
    if (this.#seenMessageKeys.size > 2_000) this.#seenMessageKeys.clear();
    return true;
  }

  #clearCursorIdleTimer(terminalId: string): void {
    const timer = this.#cursorIdleTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    this.#cursorIdleTimers.delete(terminalId);
  }

  #scheduleCursorIdlePost(terminalId: string): void {
    this.#clearCursorIdleTimer(terminalId);
    const timer = setTimeout(() => {
      this.#cursorIdleTimers.delete(terminalId);
      const pane = this.deps.state.paneByTerminal(terminalId);
      if (!pane || pane.agent_status !== "idle") return;
      const record = this.deps.registry.get(terminalId);
      if (!record?.slackThreadTs || !record.slackChannel || record.ended) return;
      void this.#sessions.refreshResponse(terminalId, "done");
    }, this.#cursorIdleDelayMs());
    timer.unref?.();
    this.#cursorIdleTimers.set(terminalId, timer);
  }

  #scheduleAgentGoneTimer(terminalId: string): void {
    if (this.#agentGoneTimers.has(terminalId)) return;
    const timer = setTimeout(() => {
      this.#agentGoneTimers.delete(terminalId);
      void this.#confirmAgentGone(terminalId);
    }, this.#agentGoneDelayMs());
    timer.unref?.();
    this.#agentGoneTimers.set(terminalId, timer);
  }

  #clearAgentGoneTimer(terminalId: string): void {
    const timer = this.#agentGoneTimers.get(terminalId);
    if (!timer) return;
    clearTimeout(timer);
    this.#agentGoneTimers.delete(terminalId);
  }

  async #confirmAgentGone(terminalId: string): Promise<void> {
    const { state, registry } = this.deps;
    const record = registry.get(terminalId);
    if (!record || record.ended || !record.slackThreadTs) return;
    const pane = state.paneByTerminal(terminalId);
    if (!pane || pane.agent) return;
    // herdr can omit agent briefly while the turn is still active.
    if (pane.agent_status === "working" || pane.agent_status === "blocked") {
      this.#scheduleAgentGoneTimer(terminalId);
      return;
    }
    await this.#endSession(terminalId);
  }

  /** End a session once and replace its card with a read-only state. */
  async #endSession(terminalId: string, closedByUser = false): Promise<void> {
    const { registry, log } = this.deps;
    const record = registry.markEnded(terminalId, Date.now(), closedByUser);
    if (!record) return;
    await this.#sessions.closeHeader(terminalId).catch(() => undefined);
    log(`session ended: ${record.title || terminalId}`);
    registry.save();
    this.#scheduleHome();
  }

  /** Open the launch modal; skeleton first because trigger_id expires quickly. */
  async #openNewAgentModal(triggerId: string): Promise<void> {
    const viewId = await this.deps.transport.openModal(triggerId, skeletonModal("New agent"));
    const [workspaces, worktrees] = await Promise.all([
      this.deps.client.workspaceList().catch(() => []),
      this.deps.client.worktreeList().catch(() => []),
    ]);
    await this.deps.transport.updateModal(
      viewId,
      buildNewAgentModal({
        workspaces,
        worktrees,
        catalog: loadCatalog(),
        defaults: readLastLaunch(this.deps.instance),
      }),
    );
  }

  async #launchFromModal(userId: string, channel: string, view: unknown): Promise<void> {
    const submission = parseNewAgentSubmission(view);
    if (!submission) {
      await this.#ephemeral(channel, "That form was missing an agent.");
      return;
    }

    // Always auto mode: remote launches cannot answer permission prompts.
    const entry = findEntry(loadCatalog(), submission.kind);
    const mode = autoModeFor(entry);

    writeLastLaunch(this.deps.instance, {
      ...(submission.workspaceId ? { workspaceId: submission.workspaceId } : {}),
      ...(submission.cwd ? { cwd: submission.cwd } : {}),
      kind: submission.kind,
    });

    const name = sanitizeAgentName(submission.label ?? submission.kind);
    const result = await launchAgent(this.deps.client, {
      kind: submission.kind,
      mode,
      name,
      ...(submission.workspaceId ? { workspaceId: submission.workspaceId } : {}),
      ...(submission.cwd ? { cwd: submission.cwd } : {}),
      ...(submission.label ? { label: submission.label } : {}),
      ...(submission.firstPrompt ? { firstPrompt: submission.firstPrompt } : {}),
    });

    // The outcome message is the only record of a first prompt that was lost,
    // so it belongs in the log and not just in an ephemeral the user may miss.
    const delivery =
      result.promptDelivered === undefined ? "" : ` delivered=${result.promptDelivered}`;
    const why = result.message ? ` msg=${result.message}` : "";
    this.deps.log(
      `launch ${submission.kind}/${mode.id} → ${result.ok ? "ok" : "failed"} pane=${result.paneId ?? "?"} firstPrompt=${submission.firstPrompt ? "yes" : "no"}${delivery}${why}`,
    );
    if (!result.ok) {
      await this.#ephemeral(channel, `Could not start ${submission.kind}: ${result.message}`);
      return;
    }
    await this.#ephemeral(
      channel,
      result.promptDelivered === false
        ? `⚠️ Started *${submission.kind}*, but your first prompt did not reach it — ` +
            `open it from the *Home* tab and use *Reply* to send it. (${result.message})`
        : result.message
          ? `Started *${submission.kind}* — ${result.message}`
          : `Started *${submission.kind}* in ${mode.label}. It will appear on the Home tab.`,
    );
    await this.publishHome(userId);
  }

  stop(): void {
    if (this.#homeTimer) clearTimeout(this.#homeTimer);
    this.#homeTimer = null;
    for (const timer of this.#agentGoneTimers.values()) clearTimeout(timer);
    this.#agentGoneTimers.clear();
    for (const timer of this.#cursorIdleTimers.values()) clearTimeout(timer);
    this.#cursorIdleTimers.clear();
    this.#seenMessageKeys.clear();
    this.deps.registry.save();
  }

  /** Refresh registry entries from live state, then retire anything gone. */
  reconcileSessions(): void {
    const { state, registry, log } = this.deps;
    for (const pane of state.agentPanes()) {
      if (registry.get(pane.terminal_id)?.ended) {
        void this.#sessions.reviveIfLive(pane.terminal_id).then((ok) => {
          if (ok) registry.save();
        });
      }
      registry.upsert(pane.terminal_id, {
        lastKnownPaneId: pane.pane_id,
        agentKind: pane.agent ?? "agent",
        title: pane.terminal_title_stripped ?? pane.title ?? "",
        cwd: pane.cwd ?? "",
        workspaceId: pane.workspace_id,
        tabId: pane.tab_id,
        lastStatus: state.statusOf(pane.terminal_id) ?? pane.agent_status,
      });
    }

    const live = new Set(state.agentPanes().map((pane) => pane.terminal_id));
    const result = sweepOrphans(registry, live, state.workspaces.size);
    if (result.skipped) {
      log("orphan sweep skipped: snapshot had no workspaces");
    }
    for (const orphan of result.orphaned) {
      log(`session ended: ${orphan.title}`);
      void this.#sessions.closeHeader(
        registry.entries().find(([, record]) => record === orphan)?.[0] ?? "",
      );
    }
    registry.save();
  }

  /** Build the Home model from live state, never from the registry alone. */
  homeAgents(): HomeAgent[] {
    const { state, registry } = this.deps;
    // Mint refs for new agents so Home buttons always carry a valid target.
    for (const pane of state.agentPanes()) {
      if (!registry.get(pane.terminal_id)) {
        registry.upsert(pane.terminal_id, {
          lastKnownPaneId: pane.pane_id,
          agentKind: pane.agent ?? "agent",
          title: pane.terminal_title_stripped ?? pane.title ?? "",
          cwd: pane.cwd ?? "",
          workspaceId: pane.workspace_id,
          tabId: pane.tab_id,
          lastStatus: state.statusOf(pane.terminal_id) ?? pane.agent_status,
        });
      }
    }
    return state.agentPanes().map((pane) => {
      const record = registry.get(pane.terminal_id);
      const workspace = state.workspaces.get(pane.workspace_id);
      // Home only lists live panes, so an ended record here is one the user
      // closed (revival is blocked for those). Keep its ref so Home can offer
      // Open, which re-attaches the card instead of leaving it stranded.
      return agentFromPane(
        pane,
        record?.ref ?? "",
        workspace?.label ?? pane.workspace_id,
        state.statusOf(pane.terminal_id) ?? pane.agent_status,
        record?.ended || !record?.slackChannel || !record.slackThreadTs
          ? undefined
          : resolveThreadPermalink(
              record.slackChannel,
              record.slackThreadTs,
              record.slackPermalink,
            ),
      );
    });
  }

  async publishHome(userId: string): Promise<void> {
    const { transport, tail, budget, config, log } = this.deps;
    if (!budget.tryConsume()) {
      log("home publish skipped: rate budget exhausted");
      return;
    }
    try {
      await transport.publishHome(
        userId,
        buildHome({
          instanceLabel: config.label || "herdr",
          agents: this.homeAgents(),
          herdr: tail.status,
          slackConnected: transport.connected,
          syncedAgoMs: this.#lastSyncAt === null ? null : Date.now() - this.#lastSyncAt,
        }),
      );
    } catch (error) {
      log(`home publish failed: ${(error as Error).message}`);
    }
  }

  /** Which session owns a Slack thread, if any. */
  terminalForThread(threadTs: string): string | undefined {
    for (const [terminalId, record] of this.deps.registry.entries()) {
      if (record.slackThreadTs === threadTs) return terminalId;
    }
    return undefined;
  }

  async #dispatch(
    actionId: string,
    terminalId: string,
    value: string,
    channel: string,
    triggerId: string,
    viewId?: string,
  ): Promise<void> {
    if (actionId.startsWith(`${SESSION_ACTIONS.historyPage}_`)) {
      const page = Number(actionId.slice(`${SESSION_ACTIONS.historyPage}_`.length));
      if (viewId && Number.isInteger(page) && page >= 0) {
        await this.deps.transport.updateModal(
          viewId,
          buildHistoryModal(
            this.deps.registry.get(terminalId)?.ref ?? "",
            this.deps.registry.turns(terminalId),
            page,
          ),
        );
      }
      return;
    }
    if (SessionController.isMenuChoiceAction(actionId)) {
      await this.#dispatchMenuChoice(terminalId, value, channel);
      return;
    }
    await this.#dispatchSessionControl(actionId, terminalId, channel, triggerId);
  }

  async #dispatchMenuChoice(terminalId: string, value: string, channel: string): Promise<void> {
    const decoded = SessionController.decodeMenuChoice(value);
    if (!decoded) {
      // Malformed menu choices are never forwarded as keypresses.
      this.deps.log("rejected malformed menu choice");
      await this.#ephemeral(channel, "That option is no longer valid.", {
        threadTs: this.#threadFor(terminalId),
      });
      return;
    }
    const prior = this.deps.registry.turns(terminalId).at(-1);
    const baseline =
      prior?.status === "blocked" ? "" : await this.#sessions.captureBaseline(terminalId);
    const outcome = await this.#sessions.chooseMenuOption(terminalId, decoded.choice);
    if (!outcome.ok) {
      await this.#ephemeral(channel, outcome.message ?? "That did not work.");
      return;
    }
    let latest = this.deps.registry.turns(terminalId).at(-1);
    if (!latest || latest.status !== "blocked") {
      latest = this.deps.registry.startTurn(
        terminalId,
        `Selected option ${decoded.choice}`,
        baseline,
      );
    }
    if (latest?.status === "blocked") {
      this.deps.registry.updateTurn(terminalId, latest.id, { status: "working" });
    }
    this.deps.registry.save();
    await this.#sessions.updateCard(terminalId);
    // No retry on timeout; tell the user instead.
    if (!(await this.#sessions.verifyAcknowledged(terminalId, this.deps.ackTimeoutMs))) {
      await this.#ephemeral(
        channel,
        "⚠️ No response yet — the agent may still be waiting. Open the session to check.",
      );
    }
  }

  async #dispatchSessionControl(
    actionId: string,
    terminalId: string,
    channel: string,
    triggerId: string,
  ): Promise<void> {
    switch (actionId) {
      case SESSION_ACTIONS.reply: {
        const record = this.deps.registry.get(terminalId);
        if (!record || record.ended) return;
        await this.deps.transport.openModal(
          triggerId,
          buildReplyModal(record.ref, record.title || record.agentKind),
        );
        return;
      }
      case SESSION_ACTIONS.refresh:
        await this.#sessions.refreshResponse(terminalId);
        return;
      case SESSION_ACTIONS.history: {
        const record = this.deps.registry.get(terminalId);
        if (!record) return;
        await this.deps.transport.openModal(
          triggerId,
          buildHistoryModal(record.ref, this.deps.registry.turns(terminalId)),
        );
        return;
      }
      case SESSION_ACTIONS.end: {
        const outcome = await this.#sessions.closeTerminal(terminalId);
        if (!outcome.ok) {
          await this.#ephemeral(channel, outcome.message ?? "That did not work.", {
            threadTs: this.#threadFor(terminalId),
          });
          return;
        }
        const active = this.deps.registry.activeTurn(terminalId);
        if (active) {
          this.deps.registry.updateTurn(terminalId, active.id, {
            status: "stopped",
            completedAt: Date.now(),
          });
        }
        await this.#endSession(terminalId, true);
        return;
      }
      default: {
        const outcome = await this.#sessions.openSession(terminalId, channel);
        if (!outcome.ok) await this.#ephemeral(channel, outcome.message ?? "That did not work.");
        return;
      }
    }
  }

  /**
   * Send one reply, returning a message when it did not reach the agent.
   *
   * The prompt goes out before the turn is recorded and before the card is
   * touched, so a refusal needs no rollback and can be reported in the modal
   * the user is still looking at. Redrawing the card is Slack I/O and would eat
   * the submission's time budget, so it happens after this returns.
   */
  async #submitTurn(terminalId: string, prompt: string): Promise<string | undefined> {
    const record = this.deps.registry.get(terminalId);
    if (!record || record.ended) return "That session has ended — reopen it from the Home tab.";
    if (this.deps.registry.activeTurn(terminalId)) {
      this.deps.log(`reply ignored for ${terminalId}: turn already active`);
      return "This agent is still working on your last reply. Wait for it to finish.";
    }

    const baseline = await this.#sessions.captureBaseline(terminalId);
    const outcome = await this.#sessions.prompt(terminalId, prompt);
    if (!outcome.ok) return outcome.message ?? "The prompt could not be delivered.";

    const turn = this.deps.registry.startTurn(terminalId, prompt, baseline);
    if (!turn) return "That session has ended — reopen it from the Home tab.";
    this.deps.registry.save();
    void this.#sessions.updateCard(terminalId);
    return undefined;
  }

  /** Handle bare DMs and agent-container suggested prompts as commands. */
  async #handleBareMessage(channel: string, userId: string, text: string): Promise<void> {
    const command = text
      .trim()
      .toLowerCase()
      .replace(/[?.!]+$/, "");
    const wantsAttention = /\b(blocked|needs?|attention|waiting)\b/.test(command);
    const wantsList = /\b(herd|agents?|list|status|show)\b/.test(command);

    if (wantsAttention || wantsList) {
      await this.publishHome(userId);
      await this.#ephemeral(channel, this.#herdSummary(wantsAttention && !wantsList));
      return;
    }
    await this.#ephemeral(
      channel,
      "Open an agent from the *Home* tab and use *Reply* on its session card to prompt it. " +
        "Ask me *what needs my attention* for a summary.",
    );
  }

  /** A one-message answer to "what is my herd doing". */
  #herdSummary(attentionOnly: boolean): string {
    const agents = this.homeAgents();
    if (agents.length === 0)
      return "No agents running. Start one with *＋ New agent* on the Home tab.";

    const blocked = agents.filter((a) => a.status === "blocked");
    if (attentionOnly && blocked.length === 0) {
      return `Nothing is waiting on you. ${agents.length} agent${agents.length === 1 ? "" : "s"} running.`;
    }

    const shown = (attentionOnly ? blocked : agents).slice(0, 10);
    const lines = shown.map(
      (a) =>
        `${GLYPH[a.status]} *${escapeMrkdwn(a.agent)}* · ${escapeMrkdwn(a.title)}${a.permalink ? ` — <${a.permalink}|open>` : ""}`,
    );
    const more = (attentionOnly ? blocked.length : agents.length) - shown.length;
    if (more > 0) lines.push(`_… and ${more} more on the Home tab._`);
    return [
      blocked.length > 0 ? `*${blocked.length} waiting on you*` : "*Your herd*",
      ...lines,
    ].join("\n");
  }

  #scheduleHome(): void {
    if (this.#homeTimer) return;
    this.#homeTimer = setTimeout(() => {
      this.#homeTimer = null;
      for (const userId of this.deps.config.allowedUsers) {
        void this.publishHome(userId);
      }
    }, HOME_DEBOUNCE_MS);
    this.#homeTimer.unref?.();
  }

  /** Resolve a reply channel; App Home and modals may omit one. */
  async #replyChannel(ctx: { channel: string; userId: string }): Promise<string> {
    if (ctx.channel) return ctx.channel;
    const cached = this.#dmChannels.get(ctx.userId);
    if (cached) return cached;
    try {
      const channel = await this.deps.transport.openDm(ctx.userId);
      if (channel) this.#dmChannels.set(ctx.userId, channel);
      return channel;
    } catch {
      return "";
    }
  }

  /** Post user-only notes; use ephemeral so they never persist on the card. */
  async #ephemeral(channel: string, text: string, to?: NoticeTarget): Promise<void> {
    if (!channel || !this.deps.budget.tryConsume()) return;
    const userId = to?.userId ?? this.#lastActor;
    if (!userId) {
      await this.deps.transport.postMessage({ channel, text }).catch(() => undefined);
      return;
    }
    await this.deps.transport
      .postEphemeral({
        channel,
        user: userId,
        text,
        ...(to?.threadTs ? { threadTs: to.threadTs } : {}),
      })
      .catch(() => undefined);
  }

  /** The thread for a terminal, when it has one, so notes land in context. */
  #threadFor(terminalId: string): string | undefined {
    return this.deps.registry.get(terminalId)?.slackThreadTs;
  }
}
