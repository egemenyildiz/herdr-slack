import { describe, expect, it } from "vitest";
import { MAX_CHOICES, buttonLabel, parseMenu, renderableChoices } from "../../src/agents/menu.js";

/** Shaped like what `pane.read --source detection` actually returns. */
const claudePrompt = `
Claude wants to edit src/index.ts

Do you want to make this edit?
❯ 1. Yes
  2. Yes, and don't ask again this session
  3. No, and tell Claude what to do differently
`;

const codexPrompt = `
Apply patch to 3 files?
  1. Approve
› 2. Approve and remember
  3. Reject
`;

describe("parseMenu", () => {
  it("parses a Claude permission prompt", () => {
    const choices = parseMenu(claudePrompt);
    expect(choices).toHaveLength(3);
    expect(choices?.[0]).toMatchObject({ number: "1", label: "Yes", highlighted: true });
    expect(choices?.[2]?.label).toContain("tell Claude");
  });

  it("parses a differently-marked cursor", () => {
    const choices = parseMenu(codexPrompt);
    expect(choices).toHaveLength(3);
    expect(choices?.[1]?.highlighted).toBe(true);
  });

  it("accepts parenthesised numbering", () => {
    const choices = parseMenu("❯ 1) Continue\n  2) Stop");
    expect(choices).toHaveLength(2);
  });

  describe("refuses things that are not live menus", () => {
    it("an ordinary numbered list with no cursor", () => {
      // The expensive mistake: buttons that look real and do nothing.
      expect(parseMenu("I will:\n  1. read the file\n  2. edit it\n  3. run tests")).toBeNull();
    });

    it("a single option", () => {
      expect(parseMenu("❯ 1. Only choice")).toBeNull();
    });

    it("numbers that do not run 1..N", () => {
      expect(parseMenu("❯ 1. First\n  3. Third")).toBeNull();
    });

    it("numbers out of order", () => {
      expect(parseMenu("❯ 2. Second\n  1. First")).toBeNull();
    });

    it("plain prose", () => {
      expect(parseMenu("Working on it. This may take a while.")).toBeNull();
    });

    it("empty output", () => {
      expect(parseMenu("")).toBeNull();
    });

    it("a version list that happens to be numbered", () => {
      expect(parseMenu("found:\n1. v1.2.3\n2. v1.2.4")).toBeNull();
    });
  });

  it("ignores surrounding chatter", () => {
    const choices = parseMenu("some output above\n\n❯ 1. Yes\n  2. No\n\nmore below");
    expect(choices).toHaveLength(2);
  });
});

describe("buttonLabel", () => {
  it("prefixes the number so the mapping is obvious", () => {
    expect(buttonLabel({ number: "2", label: "Approve", highlighted: false })).toBe("2. Approve");
  });

  it("stays inside Slack's button limit", () => {
    const label = buttonLabel({ number: "1", label: "x".repeat(200), highlighted: false });
    expect(label.length).toBeLessThanOrEqual(72);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("renderableChoices", () => {
  it("caps how many buttons a phone has to show", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      number: String(i + 1),
      label: `option ${i}`,
      highlighted: i === 0,
    }));
    expect(renderableChoices(many)).toHaveLength(MAX_CHOICES);
  });

  it("keeps everything when there are few", () => {
    const choices = parseMenu(claudePrompt) ?? [];
    expect(renderableChoices(choices)).toHaveLength(3);
  });
});
