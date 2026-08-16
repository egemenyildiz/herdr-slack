/**
 * Minimal Slack Web API client.
 *
 * Deliberately not Bolt: setup and doctor run before there is any daemon, and
 * pulling a socket framework in just to call auth.test would make the CLI slower
 * to start and harder to test. Bolt owns the Socket Mode data plane only.
 */

export interface SlackAuth {
  ok: boolean;
  team?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
  url?: string;
  error?: string;
}

export class SlackApiError extends Error {
  constructor(
    readonly slackError: string,
    readonly method: string,
  ) {
    super(`${method}: ${slackError}`);
    this.name = "SlackApiError";
  }

  /** Slack reports a missing scope this way; doctor maps it to a reinstall link. */
  get missingScope(): string | undefined {
    return this.slackError === "missing_scope" ? this.slackError : undefined;
  }
}

export interface SlackCallOptions {
  token: string;
  method: string;
  body?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

export async function slackCall<T = Record<string, unknown>>({
  token,
  method,
  body = {},
  fetchImpl = fetch,
}: SlackCallOptions): Promise<T & { ok: boolean }> {
  const response = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as T & { ok: boolean; error?: string; needed?: string };
  if (!payload.ok) {
    throw new SlackApiError(payload.error ?? `http_${response.status}`, method);
  }
  return payload;
}

export function authTest(token: string, fetchImpl?: typeof fetch): Promise<SlackAuth> {
  return slackCall<SlackAuth>({
    token,
    method: "auth.test",
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * Open and immediately close a Socket Mode connection.
 *
 * Validating the app-level token by its `xapp-` prefix proves nothing — a token
 * for the wrong app, or one missing connections:write, looks identical. Asking
 * Slack for a WebSocket URL is the only check that means anything.
 */
export async function verifyAppToken(appToken: string, fetchImpl?: typeof fetch): Promise<boolean> {
  try {
    const result = await slackCall<{ url?: string }>({
      token: appToken,
      method: "apps.connections.open",
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    return typeof result.url === "string" && result.url.startsWith("wss://");
  } catch {
    return false;
  }
}

/** Deep link to an app's install page, for doctor's fix hints. */
export function installUrl(appId: string): string {
  return `https://api.slack.com/apps/${appId}/install-on-team`;
}
