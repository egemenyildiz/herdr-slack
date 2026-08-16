import { describe, expect, it } from "vitest";
import { DryRunTransport, blockText, formatWrite } from "../../src/slack/dry-run-transport.js";

const build = () => {
  const seen: string[] = [];
  const transport = new DryRunTransport((write) => seen.push(formatWrite(write)));
  return { transport, seen };
};

describe("DryRunTransport", () => {
  it("records what it would have posted", async () => {
    const { transport, seen } = build();
    await transport.postMessage({ channel: "D1", text: "hello there" });

    expect(transport.writes[0]).toMatchObject({ api: "chat.postMessage", target: "D1" });
    expect(seen[0]).toContain("would send chat.postMessage → D1");
    expect(seen[0]).toContain("hello there");
  });

  it("returns ids that are synthetic but usable", async () => {
    // Returning "" would leave the registry with no thread ts, so the card's
    // chat.update path would never run — a dry run that exercises a code path
    // production never takes is worse than no dry run.
    const { transport } = build();
    const first = await transport.postMessage({ channel: "D1", text: "a" });
    const second = await transport.postMessage({ channel: "D1", text: "b" });

    expect(first.ts).toBeTruthy();
    expect(first.channel).toBe("D1");
    expect(second.ts).not.toBe(first.ts);
    expect(await transport.openModal("t", { type: "modal" })).toBeTruthy();
    expect(await transport.openDm("U1")).toContain("U1");
  });

  it("threads a reply onto its parent", async () => {
    const { transport } = build();
    await transport.postMessage({ channel: "D1", text: "reply", threadTs: "111.2" });
    expect(transport.writes[0]?.target).toContain("thread 111.2");
  });

  it("records every write kind", async () => {
    const { transport } = build();
    await transport.updateMessage({ channel: "D1", ts: "1.0", text: "u" });
    await transport.publishHome("U1", [{ type: "section" }]);
    await transport.openModal("t", { type: "modal" });
    await transport.updateModal("V1", { type: "modal" });

    expect(transport.writes.map((w) => w.api)).toEqual([
      "chat.update",
      "views.publish",
      "views.open",
      "views.update",
    ]);
  });

  it("connects to nothing and reports itself live", async () => {
    // Surfaces render a "reconnecting" banner when not connected, and a dry run
    // that only ever showed the degraded view would not show what was asked for.
    const { transport, seen } = build();
    await transport.start();
    await transport.stop();

    expect(transport.connected).toBe(true);
    expect(transport.idleMs).toBe(0);
    expect(seen).toEqual([]);
  });

  it("accepts inbound handlers and never calls them", async () => {
    const { transport } = build();
    const fail = () => {
      throw new Error("dry run received something inbound");
    };
    transport.onAction(fail);
    transport.onViewSubmit(fail);
    transport.onMessage(fail);
    transport.onHomeOpened(fail);

    let connected = false;
    transport.onConnectionChange((value) => {
      connected = value;
    });
    expect(connected).toBe(true);
  });
});

describe("blockText", () => {
  it("finds text nested anywhere in a Block Kit payload", () => {
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Herd" } },
      {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Open" }, value: "ref" }],
      },
    ];
    expect(blockText(blocks)).toEqual(["Herd", "Open"]);
  });

  it("ignores non-string text fields and non-objects", () => {
    expect(blockText([{ text: 42 }, null, "bare", undefined])).toEqual([]);
  });
});

describe("formatWrite", () => {
  it("shows the words, not only the byte count", () => {
    const out = formatWrite({
      api: "views.publish",
      target: "U1",
      blocks: [{ text: { type: "mrkdwn", text: "⚙️ claude · fix-auth" } }],
      bytes: 10,
    });
    expect(out).toContain("fix-auth");
  });

  it("prints a bare header when there is nothing human-visible", () => {
    const out = formatWrite({
      api: "views.update",
      target: "V1",
      blocks: [{ type: "modal" }],
      bytes: 2,
    });
    expect(out).toBe("would send views.update → V1 (2 bytes)");
  });
});
