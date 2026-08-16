/**
 * Synthetic credentials for the redaction tests.
 *
 * `redact.ts` matches on prefix, charset and length, so these must be *shaped*
 * like real credentials. They do not have to look plausible, and earlier
 * versions that did kept tripping the secret scanner on this very repo.
 *
 * The convention: every value contains the literal EXAMPLE, and `.gitleaks.toml`
 * allowlists exactly "credential shape AND that marker". A real `sk-9f2c…` is
 * still caught; `sk-EXAMPLE…` is not. Written as plain readable literals on
 * purpose — assembling them from fragments to dodge a scanner made the tests
 * harder to read for no security benefit.
 *
 * If you add a fixture, keep the marker, or CI will tell you.
 */
export const FAKE = {
  openai: "sk-EXAMPLE000000000000000",
  anthropic: "sk-ant-EXAMPLE0000000000000",
  slackBot: "xoxb-EXAMPLE-000000000",
  slackApp: "xapp-1-EXAMPLE00000000",
  github: "ghp_EXAMPLE0000000000000000000",
  githubFine: "github_pat_EXAMPLE00000000000000",
  aws: "AKIAEXAMPLE000000000",
  google: "AIzaEXAMPLE00000000000000000000000",
  stripe: "sk_live_EXAMPLE00000000000",
  npm: "npm_EXAMPLE00000000000000000000000",
} as const;

/** Env-assignment fixtures for the KEY=value rule. */
export const FAKE_ASSIGNMENTS: [line: string, name: string][] = [
  ["API_KEY=EXAMPLE_NOT_A_REAL_VALUE", "API_KEY"],
  ["DATABASE_PASSWORD: EXAMPLE_NOT_A_REAL_PASSWORD", "DATABASE_PASSWORD"],
  ["MY_SECRET = 'EXAMPLE_NOT_A_REAL_SECRET'", "MY_SECRET"],
  [`AWS_ACCESS_KEY_ID=${FAKE.aws}`, "AWS_ACCESS_KEY_ID"],
];

/** A syntactically valid but obviously fake PEM block. */
export const FAKE_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "EXAMPLEnotarealkey0000000000000000",
  "EXAMPLEnotarealkey1111111111111111",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
