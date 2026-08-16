/**
 * Lightweight terminal styling for the setup wizard.
 *
 * No chalk dependency — ANSI only when stdout is a TTY so plugin logs and
 * fixtures stay readable plain text.
 */

const useColor = (): boolean => Boolean(process.stdout.isTTY);

const wrap =
  (open: string, close = "\u001b[0m") =>
  (text: string): string =>
    useColor() ? `${open}${text}${close}` : text;

export const bold = wrap("\u001b[1m");
export const dim = wrap("\u001b[2m");
export const green = wrap("\u001b[32m");
export const yellow = wrap("\u001b[33m");
export const cyan = wrap("\u001b[36m");
export const red = wrap("\u001b[31m");

export const ok = (text: string): string => `${green("✓")} ${text}`;
export const warn = (text: string): string => `${yellow("!")} ${text}`;
export const tip = (text: string): string => `${cyan("→")} ${text}`;

const RULE = "─".repeat(64);

/** Big step header so a long scroll still reads as a sequence. */
export function stepBanner(n: number, total: number, title: string): string {
  const label = `  Step ${n}/${total} · ${title}`;
  return `\n${cyan(RULE)}\n${bold(label)}\n${cyan(RULE)}\n`;
}

/** Opening banner for the whole wizard. */
export function wizardBanner(instance: string, mode: string): string {
  const modeNote = mode === "fresh" ? "" : ` · ${mode}`;
  return [
    "",
    bold("╭──────────────────────────────────────────────────────────────╮"),
    bold("│  herdr-slack setup                                           │"),
    bold("╰──────────────────────────────────────────────────────────────╯"),
    tip(`Instance ${bold(instance)}${modeNote}`),
    "",
  ].join("\n");
}

/** A framed callout block. */
export function box(title: string, lines: string[]): string {
  const width = 64;
  const top = `┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 3))}┐`;
  const bottom = `└${"─".repeat(width)}┘`;
  const body = lines.map((line) => {
    const pad = Math.max(0, width - 1 - line.length);
    return `│ ${line}${" ".repeat(pad)}│`;
  });
  return [yellow(top), ...body.map((l) => yellow(l)), yellow(bottom)].join("\n");
}
