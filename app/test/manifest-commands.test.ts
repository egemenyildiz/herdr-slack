import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every command herdr-plugin.toml invokes must actually exist.
 *
 * `[[actions]] restart` shipped pointing at `daemon restart`, which was never
 * implemented — the action failed with "unknown daemon command" for anyone who
 * clicked it. Nothing else connects the manifest to the CLI, so nothing caught
 * it: the manifest is data herdr reads, and the CLI's dispatch is a switch
 * statement neither one knows about.
 */
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const manifest = readFileSync(path.join(repoRoot, "herdr-plugin.toml"), "utf8");
const cli = readFileSync(path.join(repoRoot, "app", "src", "cli.ts"), "utf8");

/** Every `command = [...]` array in the manifest. */
function manifestCommands(): string[][] {
  const commands: string[][] = [];
  for (const match of manifest.matchAll(/^command\s*=\s*\[(.+)\]$/gm)) {
    const parts = [...(match[1] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
    commands.push(parts);
  }
  return commands;
}

/** Top-level commands, from the dispatch table in cli.ts. */
function topLevelCommands(): Set<string> {
  const block = cli.slice(
    cli.indexOf("const COMMANDS"),
    cli.indexOf("};", cli.indexOf("const COMMANDS")),
  );
  return new Set([...block.matchAll(/^\s*(\w[\w-]*):/gm)].map((m) => m[1] ?? ""));
}

/** Subcommands handled by `cmdDaemon`'s switch. */
function daemonSubcommands(): Set<string> {
  const start = cli.indexOf("async function cmdDaemon");
  const block = cli.slice(start, cli.indexOf("\n}", start));
  return new Set([...block.matchAll(/case "([^"]+)":/g)].map((m) => m[1] ?? ""));
}

describe("herdr-plugin.toml commands", () => {
  it("finds commands to check", () => {
    // A regex that silently matches nothing would make every assertion vacuous.
    expect(manifestCommands().length).toBeGreaterThan(3);
    expect(topLevelCommands().size).toBeGreaterThan(3);
    expect(daemonSubcommands().size).toBeGreaterThan(3);
  });

  it("only invokes CLI commands that exist", () => {
    const top = topLevelCommands();
    const daemon = daemonSubcommands();

    for (const parts of manifestCommands()) {
      // Skip build hooks like ["npm", "ci", "--omit=dev"].
      const cliIndex = parts.findIndex((part) => part.endsWith("cli.js"));
      if (cliIndex < 0) continue;

      const [command, sub] = [parts[cliIndex + 1], parts[cliIndex + 2]];
      expect(command, `manifest invokes an unknown command: ${parts.join(" ")}`).toBeDefined();
      expect(top, `manifest invokes an unknown command: ${parts.join(" ")}`).toContain(command);

      if (command === "daemon" && sub && !sub.startsWith("-")) {
        expect(daemon, `manifest invokes an unknown daemon subcommand: ${sub}`).toContain(sub);
      }
    }
  });

  it("covers restart specifically, since that is the one that shipped broken", () => {
    expect(daemonSubcommands()).toContain("restart");
  });

  it("pairs setup and reset actions with popup pane entrypoints", () => {
    expect(manifest).toContain('id = "setup"\ntitle = "herdr-slack setup"\nplacement = "popup"');
    expect(manifest).toContain('id = "reset"\ntitle = "herdr-slack reset"\nplacement = "popup"');
    expect(manifest).toContain('command = ["node", "app/dist/cli.js", "reset", "--yes", "--pane"]');
    expect(manifest).toContain('command = ["node", "app/dist/cli.js", "reset", "--open"]');
  });
});
