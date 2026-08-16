import { describe, expect, it } from "vitest";
import { box, ok, stepBanner, tip, wizardBanner } from "../../src/config/setup-style.js";

describe("setup-style", () => {
  it("renders a wizard banner with the instance name", () => {
    expect(wizardBanner("default", "fresh")).toContain("herdr-slack setup");
    expect(wizardBanner("default", "fresh")).toContain("default");
    expect(wizardBanner("default", "resume")).toContain("resume");
  });

  it("renders step banners and callouts without throwing", () => {
    expect(stepBanner(2, 6, "Create the Slack app")).toContain("Step 2/6");
    expect(ok("done")).toContain("done");
    expect(tip("next")).toContain("next");
    expect(box("Title", ["line one", "line two"])).toContain("Title");
  });
});
