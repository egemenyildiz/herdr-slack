/**
 * Escape helpers for Slack mrkdwn.
 *
 * Terminal→Slack content is extracted (`response.ts`) and rendered as section
 * text (`responseSections`), not as fenced terminal dumps. What remains here is
 * the escaping every interpolated string still needs.
 */

/** Escape terminal-derived strings before interpolating into mrkdwn. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One-line summary for a message's fallback text and notifications. */
export function summaryLine(agent: string, status: string, title: string): string {
  const trimmed = title.trim() || "(untitled)";
  return `${agent} · ${status} · ${trimmed}`.slice(0, 150);
}
