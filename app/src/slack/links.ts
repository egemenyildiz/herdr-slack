/** Slack permalink helpers — synthesize thread-opening URLs with ?thread_ts=&cid=. */

export function tsToPathSegment(ts: string): string {
  return `p${ts.replace(".", "")}`;
}

export function isThreadOpeningPermalink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.has("thread_ts") && parsed.searchParams.has("cid");
  } catch {
    return false;
  }
}

export function threadPermalink(base: string, channel: string, threadTs: string): string {
  const origin = base.replace(/\/$/, "");
  const path = `/archives/${channel}/${tsToPathSegment(threadTs)}`;
  const params = new URLSearchParams({ thread_ts: threadTs, cid: channel });
  return `${origin}${path}?${params.toString()}`;
}

/** Upgrade a bare getPermalink result, or build from channel + ts when origin is known. */
export function resolveThreadPermalink(
  channel: string,
  threadTs: string,
  existing?: string,
): string | undefined {
  if (existing && isThreadOpeningPermalink(existing)) return existing;

  let base: string | undefined;
  if (existing) {
    try {
      base = new URL(existing).origin;
    } catch {
      base = undefined;
    }
  }
  if (!base) return undefined;

  return threadPermalink(base, channel, threadTs);
}
