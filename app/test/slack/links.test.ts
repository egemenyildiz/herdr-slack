import { describe, expect, it } from "vitest";
import {
  isThreadOpeningPermalink,
  resolveThreadPermalink,
  threadPermalink,
  tsToPathSegment,
} from "../../src/slack/links.js";

describe("tsToPathSegment", () => {
  it("drops the dot from a Slack ts", () => {
    expect(tsToPathSegment("1234567890.123456")).toBe("p1234567890123456");
  });
});

describe("isThreadOpeningPermalink", () => {
  it("recognises the thread-opening query params", () => {
    expect(
      isThreadOpeningPermalink("https://acme.slack.com/archives/D1/p123?thread_ts=123.456&cid=D1"),
    ).toBe(true);
  });

  it("rejects a bare archives link", () => {
    expect(isThreadOpeningPermalink("https://acme.slack.com/archives/D1/p1234567890123456")).toBe(
      false,
    );
  });
});

describe("threadPermalink", () => {
  it("builds the thread-opening form", () => {
    expect(threadPermalink("https://acme.slack.com", "D123", "111.222")).toBe(
      "https://acme.slack.com/archives/D123/p111222?thread_ts=111.222&cid=D123",
    );
  });
});

describe("resolveThreadPermalink", () => {
  it("passes through a link that already opens the thread", () => {
    const link = "https://acme.slack.com/archives/D1/p123?thread_ts=111.0&cid=D1&extra=1";
    expect(resolveThreadPermalink("D1", "111.0", link)).toBe(link);
  });

  it("upgrades a bare link captured before any replies", () => {
    expect(
      resolveThreadPermalink("D123", "111.222", "https://acme.slack.com/archives/D123/p111222"),
    ).toBe("https://acme.slack.com/archives/D123/p111222?thread_ts=111.222&cid=D123");
  });

  it("returns nothing when there is no origin to borrow", () => {
    expect(resolveThreadPermalink("D123", "111.222")).toBeUndefined();
  });
});
