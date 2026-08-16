/**
 * Best-effort secret redaction for anything leaving for Slack.
 *
 * This is a pattern matcher, not a guarantee, and it is described that way in
 * SECURITY.md on purpose — a user who believes it is airtight will make worse
 * decisions than one who knows it is a safety net. The real control is
 * contentMode; this catches the accident where an agent prints a key.
 *
 * A regression here is a security bug, not a cosmetic one.
 */

export const REDACTED = "‹redacted›";

interface Rule {
  name: string;
  pattern: RegExp;
  /** Replace only this capture group, so surrounding context survives. */
  group?: number;
}

const RULES: Rule[] = [
  // Provider tokens with distinctive prefixes.
  { name: "openai", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: "slack", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "slack-app", pattern: /\bxapp-[0-9]-[A-Za-z0-9-]{10,}\b/g },
  { name: "github", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "github-fine", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "aws-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "google", pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { name: "stripe", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "npm", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  // Bearer headers and basic-auth in URLs.
  { name: "bearer", pattern: /\b(?:Bearer|Token)\s+([A-Za-z0-9._~+/-]{16,}=*)/gi, group: 1 },
  { name: "url-auth", pattern: /\/\/[^\s/:@]+:([^\s/@]{4,})@/g, group: 1 },
  // KEY=value assignments, the most common accidental leak in terminal output.
  {
    name: "assignment",
    pattern:
      /\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'&]{6,})/g,
    group: 1,
  },
];

/** PEM blocks are redacted whole — the header alone is not the secret. */
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export interface RedactionResult {
  text: string;
  /** Rule names that fired, for the audit log. Never the values. */
  hits: string[];
}

export function redact(input: string): RedactionResult {
  const hits = new Set<string>();
  let text = input;

  if (PEM.test(text)) {
    hits.add("pem");
    text = text.replace(PEM, `${REDACTED} (private key)`);
  }
  PEM.lastIndex = 0;

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (match, ...groups) => {
      const captured = rule.group ? (groups[rule.group - 1] as string | undefined) : undefined;
      if (rule.group && !captured) return match;
      hits.add(rule.name);
      // Replacing only the capture keeps "Authorization: Bearer ‹redacted›"
      // readable, which matters when the point is to see what the agent did.
      return rule.group && captured ? match.replace(captured, REDACTED) : REDACTED;
    });
  }

  return { text, hits: [...hits] };
}

/** True when anything was found. Cheaper than comparing strings at call sites. */
export function containsSecret(input: string): boolean {
  return redact(input).hits.length > 0;
}
