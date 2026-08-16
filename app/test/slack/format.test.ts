import { describe, expect, it } from "vitest";
import { escapeMrkdwn, summaryLine } from "../../src/slack/format.js";

describe("escapeMrkdwn", () => {
  it("escapes Slack control characters", () => {
    expect(escapeMrkdwn("a & b <@U1>")).toBe("a &amp; b &lt;@U1&gt;");
  });
});

describe("summaryLine", () => {
  it("fits a notification fallback under Slack's limit", () => {
    expect(summaryLine("claude", "idle", "x".repeat(200)).length).toBeLessThanOrEqual(150);
  });

  it("uses a placeholder when the title is empty", () => {
    expect(summaryLine("claude", "idle", "  ")).toContain("(untitled)");
  });
});
