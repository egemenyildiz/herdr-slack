import os from "node:os";
import path from "node:path";

/** Shorten paths under $HOME to `~/…` for pasteable doctor output. */
export function tildify(target: string, home = os.homedir()): string {
  return home && target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target;
}

/** Copy-pasteable `node …/cli.js` command — plugin is not on PATH (ADR 0002). */
export function cliEntrypoint(): string {
  // .../app/dist/config/invocation.js → .../app/dist/cli.js
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");
}

/** `node ~/path/cli.js <args>` — safe to print, safe to paste. */
export function command(args: string, entrypoint = cliEntrypoint()): string {
  return `node ${tildify(entrypoint)}${args ? ` ${args}` : ""}`;
}

export function iconPath(): string {
  // .../app/dist/config/invocation.js → repo root → assets/app-icon.png
  return path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "..",
    "assets",
    "app-icon.png",
  );
}
