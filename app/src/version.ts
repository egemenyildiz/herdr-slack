/** Minimum herdr protocol this build understands. Verify against a live herdr socket. */
export const REQUIRED_PROTOCOL = 19;

/**
 * Whether a herdr server speaking `protocol` is usable by this build.
 *
 * Newer protocols are accepted: herdr has added methods without removing ours
 * so far, and refusing to start against a newer server would break users on
 * every herdr release. `doctor` reports the mismatch either way.
 */
export function isSupportedProtocol(protocol: number): boolean {
  return Number.isInteger(protocol) && protocol >= REQUIRED_PROTOCOL;
}
