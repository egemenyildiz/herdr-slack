import os from "node:os";
import { describe, expect, it } from "vitest";
import { cliEntrypoint, command, tildify } from "../../src/config/invocation.js";

describe("tildify", () => {
  it("shortens a path under the home directory", () => {
    expect(tildify("/home/someone/ws/thing", "/home/someone")).toBe("~/ws/thing");
  });

  it("leaves paths outside the home directory alone", () => {
    expect(tildify("/opt/herdr/thing", "/home/someone")).toBe("/opt/herdr/thing");
  });

  it("does not shorten a sibling directory that merely shares a prefix", () => {
    // /home/someone-else must not become ~-else.
    expect(tildify("/home/someone-else/x", "/home/someone")).toBe("/home/someone-else/x");
  });

  it("leaves the home directory itself alone", () => {
    expect(tildify("/home/someone", "/home/someone")).toBe("/home/someone");
  });

  it("copes with an empty home", () => {
    expect(tildify("/anything", "")).toBe("/anything");
  });
});

describe("command", () => {
  it("renders a runnable node invocation", () => {
    // Every fix hint used to say "herdr-slack doctor", which is on nobody's
    // PATH — un-runnable advice printed exactly when advice was needed.
    expect(command("doctor", "/opt/p/cli.js")).toBe("node /opt/p/cli.js doctor");
  });

  it("omits a trailing space when there are no arguments", () => {
    expect(command("", "/opt/p/cli.js")).toBe("node /opt/p/cli.js");
  });

  it("shortens the entrypoint under home so output is pasteable and not personal", () => {
    const entry = `${os.homedir()}/ws/herdr-slack/app/dist/cli.js`;
    expect(command("doctor", entry)).toBe("node ~/ws/herdr-slack/app/dist/cli.js doctor");
  });

  it("resolves its own entrypoint to a cli.js that exists", () => {
    expect(cliEntrypoint().endsWith("cli.js")).toBe(true);
  });
});
