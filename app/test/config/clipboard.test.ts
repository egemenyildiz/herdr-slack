import { describe, expect, it } from "vitest";
import { looksLikeToken } from "../../src/config/clipboard.js";

// Clipboard *reading* was removed deliberately — a background loop watching
// everything a user copies is invasive whatever it filters for. Tokens are
// pasted at an explicit prompt now, and this shape check is what catches the
// common mistake of grabbing the wrong field off the settings page.

describe("looksLikeToken", () => {
  it("accepts real token shapes", () => {
    expect(looksLikeToken("xoxb-123-abc", "bot")).toBe(true);
    expect(looksLikeToken("xapp-EXAMPLE-NOT-A-REAL-TOKEN", "app")).toBe(true);
  });

  it("does not confuse the two kinds", () => {
    expect(looksLikeToken("xoxb-123", "app")).toBe(false);
    expect(looksLikeToken("xapp-123", "bot")).toBe(false);
  });

  it("rejects anything that is not a token", () => {
    for (const junk of ["", "hello", "https://example.com", "xoxb", "prefixed xoxb-123"]) {
      expect(looksLikeToken(junk, "bot")).toBe(false);
    }
  });

  it("tolerates whitespace around a paste", () => {
    expect(looksLikeToken("  xoxb-123-abc\n", "bot")).toBe(true);
  });
});
