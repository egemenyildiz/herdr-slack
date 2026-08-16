/**
 * Logical key names accepted by `agent.send_keys`.
 *
 * herdr validates every key before writing any bytes, so an unknown name fails
 * the whole call rather than half-typing into a terminal. Keep this list to keys
 * we have actually exercised (menu digits today).
 */

const DIGIT = /^[1-9]$/;

/**
 * A blocked-prompt menu selection.
 *
 * These menus commit on the digit alone, so this is deliberately a bare keypress
 * rather than `agent.prompt` — the Enter that prompt appends would land on
 * whatever prompt appears next.
 */
export function menuChoiceKeys(choice: string): string[] {
  if (!DIGIT.test(choice)) {
    throw new Error(`menu choice must be a digit 1-9, got ${JSON.stringify(choice)}`);
  }
  return [choice];
}
