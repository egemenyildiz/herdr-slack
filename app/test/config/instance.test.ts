import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDir, envPrefix, instanceKeyForSocket, stateDir } from "../../src/config/instance.js";

describe("configDir / stateDir fallback", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.config = process.env.HERDR_PLUGIN_CONFIG_DIR;
    saved.state = process.env.HERDR_PLUGIN_STATE_DIR;
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  afterEach(() => {
    if (saved.config === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = saved.config;
    if (saved.state === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = saved.state;
  });

  it("matches herdr's own plugin-scoped path when no env var is set", () => {
    // This is the bug this repo shipped once: a bare `node cli.js setup` (no
    // HERDR_PLUGIN_* — no herdr env at all) wrote here, while the setup popup —
    // invoked BY herdr, which always sets these vars — looked in herdr's own
    // plugin directory and found nothing, concluding the instance was
    // unconfigured and silently rerunning the full wizard. The fallback below
    // has to be the SAME path herdr itself would inject, not a project-owned
    // location, or the two callers disagree again the next time either one
    // changes.
    expect(configDir()).toBe(
      path.join(os.homedir(), ".config", "herdr", "plugins", "config", "herdr-slack"),
    );
    expect(stateDir("default")).toBe(
      path.join(os.homedir(), ".local", "state", "herdr", "plugins", "herdr-slack", "default"),
    );
  });

  it("still honours an explicit HERDR_PLUGIN_CONFIG_DIR / HERDR_PLUGIN_STATE_DIR", () => {
    process.env.HERDR_PLUGIN_CONFIG_DIR = "/tmp/explicit-config";
    process.env.HERDR_PLUGIN_STATE_DIR = "/tmp/explicit-state";
    expect(configDir()).toBe("/tmp/explicit-config");
    expect(stateDir("default")).toBe(path.join("/tmp/explicit-state", "default"));
  });

  it("resolves identically whether or not herdr's env vars happen to be set", () => {
    // The actual invariant that broke: two callers of this module must never
    // land on different directories for the same "no explicit override" case.
    const withoutEnv = configDir();
    process.env.HERDR_PLUGIN_CONFIG_DIR = withoutEnv;
    expect(configDir()).toBe(withoutEnv);
  });
});

describe("instanceKeyForSocket", () => {
  it("maps the unnamed session to default", () => {
    expect(instanceKeyForSocket("/Users/x/.config/herdr/herdr.sock")).toBe("default");
  });

  it("maps a named session to sess-<name>, not bare <name>", () => {
    // Bare would collide: `herdr --session default` and the unnamed session
    // would both derive "default", and setup would overwrite the other's
    // pinned team_id.
    expect(instanceKeyForSocket("/Users/x/.config/herdr/sessions/work/herdr.sock")).toBe(
      "sess-work",
    );
  });

  it("sanitises unsafe characters in a session name", () => {
    expect(instanceKeyForSocket("/x/.config/herdr/sessions/a b/herdr.sock")).toBe("sess-a-b");
  });
});

describe("envPrefix", () => {
  it("upcases and turns dashes into underscores", () => {
    expect(envPrefix("sess-work")).toBe("HERDR_SLACK_SESS_WORK_");
  });
});
