import { describe, expect, it } from "vitest";
import { REQUIRED_PROTOCOL, isSupportedProtocol } from "../src/version.js";

describe("isSupportedProtocol", () => {
  it("accepts the protocol this build was verified against", () => {
    expect(isSupportedProtocol(REQUIRED_PROTOCOL)).toBe(true);
  });

  it("accepts newer protocols rather than refusing to start", () => {
    expect(isSupportedProtocol(REQUIRED_PROTOCOL + 1)).toBe(true);
  });

  it("rejects older protocols", () => {
    expect(isSupportedProtocol(REQUIRED_PROTOCOL - 1)).toBe(false);
  });

  it("rejects values that are not whole protocol numbers", () => {
    expect(isSupportedProtocol(Number.NaN)).toBe(false);
    expect(isSupportedProtocol(19.5)).toBe(false);
  });
});
