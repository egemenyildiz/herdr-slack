import { describe, expect, it } from "vitest";
import { DeliveryLedger, parseActionPayload } from "../../src/slack/transport.js";

describe("parseActionPayload", () => {
  it("parses a session-card button that carries no view", () => {
    // A message action (button on a session card) has no `view`. Reading
    // payload.view.id unconditionally used to throw here, so the button did
    // nothing in Slack and the click was never dispatched.
    const body = {
      trigger_id: "trig-1",
      channel: { id: "D123" },
      user: { id: "U123" },
    };
    const action = { action_id: "session_refresh", value: "ref-abc" };

    const parsed = parseActionPayload(body, action);

    expect(parsed).toEqual({
      actionId: "session_refresh",
      value: "ref-abc",
      triggerId: "trig-1",
    });
    expect(parsed.viewId).toBeUndefined();
  });

  it("keeps the view id for a modal action so pagination can update in place", () => {
    const body = { trigger_id: "trig-2", view: { id: "V456" } };
    const action = { action_id: "session_history_page_1", value: "ref-xyz" };

    expect(parseActionPayload(body, action)).toEqual({
      actionId: "session_history_page_1",
      value: "ref-xyz",
      triggerId: "trig-2",
      viewId: "V456",
    });
  });

  it("returns empty fields rather than throwing on a malformed payload", () => {
    expect(parseActionPayload(undefined, undefined)).toEqual({
      actionId: "",
      value: "",
      triggerId: "",
    });
  });
});

describe("DeliveryLedger", () => {
  it("handles a redelivered interaction exactly once", () => {
    // Slack reuses the trigger_id when it redelivers, and that trigger is
    // already spent — opening a modal with it fails as exchanged_trigger_id.
    const ledger = new DeliveryLedger();
    expect(ledger.first("trig-1")).toBe(true);
    expect(ledger.first("trig-1")).toBe(false);
    expect(ledger.first("trig-1")).toBe(false);
  });

  it("treats separate clicks as separate deliveries", () => {
    const ledger = new DeliveryLedger();
    expect(ledger.first("trig-1")).toBe(true);
    expect(ledger.first("trig-2")).toBe(true);
  });

  it("forgets the oldest ids instead of growing without bound", () => {
    const ledger = new DeliveryLedger(2);
    ledger.first("a");
    ledger.first("b");
    ledger.first("c");
    expect(ledger.first("a")).toBe(true);
    expect(ledger.first("c")).toBe(false);
  });
});
