import type { InstanceConfig } from "../config/config.js";
import type { InboundContext } from "./transport.js";

/** Security boundary — every check fails closed. Held at 100% coverage. */

export type DenyReason =
  | "wrong_team"
  | "not_allowed"
  | "throttled"
  | "unknown_ref"
  | "session_ended"
  | "channel_not_permitted";

export interface Decision {
  allowed: boolean;
  reason?: DenyReason;
  message?: string;
}

const ALLOW: Decision = { allowed: true };

const DENY_TEXT: Record<DenyReason, string> = {
  wrong_team: "This request came from a different Slack workspace.",
  not_allowed: "You are not on the allowlist for this herdr instance.",
  throttled: "Too many actions in a row — wait a moment and try again.",
  unknown_ref: "That button is from an older message and no longer works.",
  session_ended: "That session has ended.",
  channel_not_permitted: "This bot only takes commands in a direct message.",
};

function deny(reason: DenyReason): Decision {
  return { allowed: false, reason, message: DENY_TEXT[reason] };
}

/** Per-user throttle — each allowed action becomes terminal I/O. */
export class ActionThrottle {
  #hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(userId: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.#hits.get(userId) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.#hits.set(userId, recent);
      return false;
    }
    recent.push(this.now());
    this.#hits.set(userId, recent);
    return true;
  }
}

export interface GuardDeps {
  config: InstanceConfig;
  throttle: ActionThrottle;
  /** Resolve an opaque ref to a live terminal id, or undefined. */
  resolveRef?: (ref: string) => string | undefined;
  /** Whether a terminal is still live. */
  isLive?: (terminalId: string) => boolean;
}

/** Gate any inbound interaction: workspace, identity, channel, rate. */
export function checkInbound(deps: GuardDeps, ctx: InboundContext): Decision {
  const { config, throttle } = deps;

  if (!ctx.teamId || ctx.teamId !== config.slack.teamId) return deny("wrong_team");
  if (!ctx.userId || !config.allowedUsers.includes(ctx.userId)) return deny("not_allowed");

  // dmOnly applies to conversations only — Home/modals have no channel id.
  // Absent surface defaults to conversation (fail closed).
  if ((ctx.surface ?? "conversation") === "conversation" && config.dmOnly) {
    if (!ctx.channel.startsWith("D")) return deny("channel_not_permitted");
  }

  if (!throttle.check(ctx.userId)) return deny("throttled");
  return ALLOW;
}

export interface TargetResolution {
  decision: Decision;
  terminalId?: string;
}

/** Resolve opaque ref → terminal_id. Never pane_id — pane.move reassigns those. */
export function resolveTarget(deps: GuardDeps, ref: string): TargetResolution {
  if (!ref) return { decision: deny("unknown_ref") };
  const terminalId = deps.resolveRef?.(ref);
  if (!terminalId) return { decision: deny("unknown_ref") };
  if (deps.isLive && !deps.isLive(terminalId)) return { decision: deny("session_ended") };
  return { decision: ALLOW, terminalId };
}

/** Both gates, in the order they must run. */
export function authorizeAction(
  deps: GuardDeps,
  ctx: InboundContext,
  ref: string,
): TargetResolution {
  const inbound = checkInbound(deps, ctx);
  if (!inbound.allowed) return { decision: inbound };
  return resolveTarget(deps, ref);
}
