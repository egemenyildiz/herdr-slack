import { execFile } from "node:child_process";

/**
 * Write-only clipboard helpers for setup (manifest copy). Tokens are pasted at
 * an explicit prompt; the clipboard is never read. See ADR 0006.
 */

export type TokenKind = "bot" | "app";

const PREFIX: Record<TokenKind, RegExp> = {
  bot: /^xoxb-[A-Za-z0-9-]+$/,
  app: /^xapp-[A-Za-z0-9-]+$/,
};

/** Shape check for a pasted token, so an obvious mistake is caught before Slack. */
export function looksLikeToken(value: string, kind: TokenKind): boolean {
  return PREFIX[kind].test(value.trim());
}

/* v8 ignore start -- shells out to the platform clipboard tools */
/** Put text on the clipboard. Returns false where there is no clipboard. */
export async function writeClipboard(text: string): Promise<boolean> {
  const candidates: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
          ];
  for (const [command, args] of candidates) {
    try {
      const child = execFile(command, args);
      child.stdin?.end(text);
      await new Promise((resolve, reject) => {
        child.on("close", resolve);
        child.on("error", reject);
      });
      return true;
    } catch {
      // Next tool; a headless box legitimately has none.
    }
  }
  return false;
}
/* v8 ignore stop */
