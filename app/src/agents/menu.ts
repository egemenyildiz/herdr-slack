/**
 * Detect the numbered selection prompt an agent shows when it blocks.
 *
 * Ported from `natori-hrj/herdr-hail`, whose heuristic is well judged: require a
 * cursor marker *and* a 1..N sequence. That marker is what separates a live
 * interactive menu from an ordinary numbered list the agent happened to print,
 * and offering buttons that do nothing is worse than offering none.
 */

export interface MenuChoice {
  /** The key that selects this option — always a single digit. */
  number: string;
  label: string;
  /** The option the agent currently has under its cursor. */
  highlighted: boolean;
}

/** Cursor glyphs seen across agent TUIs. */
const CURSOR = "[❯>›▶→]";
const CHOICE_RE = new RegExp(`^\\s*(${CURSOR})?\\s*(\\d{1,2})[.)]\\s+(.*\\S)\\s*$`, "u");

/** Slack caps a button label at 75 characters. */
const MAX_LABEL = 72;
/** More than this and a Block Kit actions row stops being usable on a phone. */
export const MAX_CHOICES = 5;

/**
 * Parse a menu out of terminal text, or return null.
 *
 * Returning null is the common case and the safe one — free-text reply still
 * works, so a missed menu costs a tap, while a false positive puts buttons on
 * screen that silently do nothing.
 */
export function parseMenu(text: string): MenuChoice[] | null {
  const choices: MenuChoice[] = [];

  for (const line of text.split("\n")) {
    const match = CHOICE_RE.exec(line);
    if (!match) continue;
    const [, cursor, number, label] = match;
    if (!number || !label) continue;
    choices.push({ number, label: label.trim(), highlighted: Boolean(cursor) });
  }

  if (choices.length < 2) return null;
  // No cursor means this is probably prose, not a live prompt.
  if (!choices.some((choice) => choice.highlighted)) return null;
  // Numbers must read 1..N in order; anything else is a list that happens to
  // start with digits.
  if (!choices.every((choice, index) => choice.number === String(index + 1))) return null;

  return choices;
}

/** Label for a Slack button, kept inside Slack's limit. */
export function buttonLabel(choice: MenuChoice): string {
  const label = `${choice.number}. ${choice.label}`;
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

/** The choices worth rendering as buttons; the rest stay available as free text. */
export function renderableChoices(choices: MenuChoice[]): MenuChoice[] {
  return choices.slice(0, MAX_CHOICES);
}
