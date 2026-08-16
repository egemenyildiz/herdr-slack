import { describe, expect, it } from "vitest";
import { menuChoiceKeys } from "../../src/herdr/keys.js";

describe("menuChoiceKeys", () => {
  it("sends a bare digit with no Enter", () => {
    // The Enter that agent.prompt appends would land on whatever prompt appears
    // next — that is the whole reason menu selection uses send_keys.
    expect(menuChoiceKeys("2")).toEqual(["2"]);
  });

  it.each(["0", "10", "", "a", "1 ", "-1"])("refuses %o rather than sending it", (bad) => {
    expect(() => menuChoiceKeys(bad)).toThrow(/digit 1-9/);
  });
});
