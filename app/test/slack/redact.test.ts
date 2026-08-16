import { describe, expect, it } from "vitest";
import { REDACTED, containsSecret, redact } from "../../src/slack/redact.js";
import { FAKE, FAKE_ASSIGNMENTS, FAKE_PEM } from "../helpers/fake-credentials.js";

describe("redact", () => {
  it.each(Object.entries(FAKE))("removes a %s credential", (_name, secret) => {
    const result = redact(`the key is ${secret} ok`);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(REDACTED);
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("removes a PEM private key whole", () => {
    const result = redact(`before\n${FAKE_PEM}\nafter`);
    expect(result.text).not.toContain("EXAMPLEnotarealkey");
    expect(result.text).toContain("before");
    expect(result.text).toContain("after");
    expect(result.hits).toContain("pem");
  });

  it("keeps the surrounding line readable for a Bearer header", () => {
    // Blanking the whole line would hide that a request was made at all.
    const result = redact("Authorization: Bearer EXAMPLEnotarealbearertoken");
    expect(result.text).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("redacts the value of a secret-looking assignment, not its name", () => {
    const result = redact('export GITHUB_TOKEN="EXAMPLE_NOT_A_REAL_TOKEN"');
    expect(result.text).toContain("GITHUB_TOKEN");
    expect(result.text).not.toContain("EXAMPLE_NOT_A_REAL_TOKEN");
  });

  it.each(FAKE_ASSIGNMENTS)("redacts %s", (line, name) => {
    const result = redact(line);
    expect(result.text).toContain(name);
    expect(result.text).toContain(REDACTED);
  });

  it("removes a password embedded in a URL", () => {
    const result = redact("psql postgres://user:EXAMPLEnotarealpw@db.internal/app");
    expect(result.text).not.toContain("EXAMPLEnotarealpw");
    expect(result.text).toContain("db.internal");
  });

  it("reports which rules fired, never the values", () => {
    const result = redact(`${FAKE.github} and ${FAKE.aws}`);
    expect(result.hits).toContain("github");
    expect(result.hits).toContain("aws-key");
    expect(result.hits.join()).not.toContain("AKIA");
  });

  describe("negatives — ordinary output must survive untouched", () => {
    it.each([
      ["a git sha", "commit 9f2c1a7e4b8d3f6a5c0e1b2d3f4a5b6c7d8e9f01"],
      ["a uuid", "id 3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
      ["base64 in a log line", "payload eyJhbGciOiJIUzI1NiJ9 decoded fine"],
      ["a file path", "wrote /Users/dev/project/src/index.ts"],
      ["a normal sentence", "the API key was rotated last week"],
      ["a version string", "installed typescript@5.7.0"],
      ["a hex colour", "background #1b1b1f"],
      ["a url without auth", "GET https://api.example.com/v1/users?limit=20"],
    ])("leaves %s alone", (_label, text) => {
      const result = redact(text);
      expect(result.text).toBe(text);
      expect(result.hits).toEqual([]);
    });
  });

  it("is idempotent", () => {
    const once = redact(`key ${FAKE.openai}`).text;
    expect(redact(once).text).toBe(once);
  });

  it("handles empty input", () => {
    expect(redact("").text).toBe("");
  });

  it("redacts every occurrence, not just the first", () => {
    const result = redact(`${FAKE.aws} then ${FAKE.aws}`);
    expect(result.text).not.toContain("AKIA");
  });
});

describe("containsSecret", () => {
  it("flags text with a credential", () => {
    expect(containsSecret(`token ${FAKE.slackBot}`)).toBe(true);
  });

  it("does not flag ordinary output", () => {
    expect(containsSecret("all tests passed in 1.2s")).toBe(false);
  });
});
