import { describe, expect, it } from "vitest";
import {
  SlackApiError,
  authTest,
  installUrl,
  slackCall,
  verifyAppToken,
} from "../../src/slack/api.js";
import { appSettingsUrl } from "../../src/slack/manifest.js";

function stub(body: unknown, status = 200): typeof fetch {
  return (async () => ({ json: async () => body, status }) as Response) as unknown as typeof fetch;
}

describe("slackCall", () => {
  it("returns the payload when Slack says ok", async () => {
    const result = await slackCall({
      token: "xoxb-1",
      method: "auth.test",
      fetchImpl: stub({ ok: true, team_id: "T1" }),
    });
    expect(result).toMatchObject({ ok: true, team_id: "T1" });
  });

  it("turns a Slack error into a typed error naming the method", async () => {
    const error = await slackCall({
      token: "xoxb-1",
      method: "chat.postMessage",
      fetchImpl: stub({ ok: false, error: "channel_not_found" }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlackApiError);
    expect((error as SlackApiError).slackError).toBe("channel_not_found");
    expect((error as SlackApiError).method).toBe("chat.postMessage");
  });

  it("falls back to the HTTP status when Slack sends no error string", async () => {
    const error = await slackCall({
      token: "xoxb-1",
      method: "auth.test",
      fetchImpl: stub({ ok: false }, 503),
    }).catch((e: unknown) => e);
    expect((error as SlackApiError).slackError).toBe("http_503");
  });

  it("flags a missing scope so doctor can offer a reinstall link", async () => {
    const error = await slackCall({
      token: "xoxb-1",
      method: "auth.test",
      fetchImpl: stub({ ok: false, error: "missing_scope" }),
    }).catch((e: unknown) => e);
    expect((error as SlackApiError).missingScope).toBe("missing_scope");
  });

  it("does not flag unrelated errors as scope problems", async () => {
    const error = await slackCall({
      token: "xoxb-1",
      method: "auth.test",
      fetchImpl: stub({ ok: false, error: "invalid_auth" }),
    }).catch((e: unknown) => e);
    expect((error as SlackApiError).missingScope).toBeUndefined();
  });
});

describe("authTest", () => {
  it("reports the workspace a token belongs to", async () => {
    const auth = await authTest("xoxb-1", stub({ ok: true, team: "Acme", team_id: "T9" }));
    expect(auth.team_id).toBe("T9");
  });
});

describe("verifyAppToken", () => {
  it("accepts a token that actually opens a socket", async () => {
    // Prefix-checking an xapp- token proves nothing: a token for the wrong app,
    // or one missing connections:write, looks identical.
    await expect(
      verifyAppToken("xapp-1", stub({ ok: true, url: "wss://wss.slack.com/x" })),
    ).resolves.toBe(true);
  });

  it("rejects a token Slack refuses", async () => {
    await expect(
      verifyAppToken("xapp-1", stub({ ok: false, error: "invalid_auth" })),
    ).resolves.toBe(false);
  });

  it("rejects a success that carries no websocket url", async () => {
    await expect(verifyAppToken("xapp-1", stub({ ok: true }))).resolves.toBe(false);
  });

  it("rejects a non-wss url", async () => {
    await expect(
      verifyAppToken("xapp-1", stub({ ok: true, url: "https://not-a-socket" })),
    ).resolves.toBe(false);
  });
});

describe("app links", () => {
  it("builds the install deep link doctor points users at", () => {
    expect(installUrl("A123")).toBe("https://api.slack.com/apps/A123/install-on-team");
  });

  it("builds settings links for each page setup deep-links to", () => {
    expect(appSettingsUrl("A1", "general")).toContain("/A1/general");
    expect(appSettingsUrl("A1", "install")).toContain("/A1/install-on-team");
    expect(appSettingsUrl("A1", "oauth")).toContain("/A1/oauth");
  });
});
