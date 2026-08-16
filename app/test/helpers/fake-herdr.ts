import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EventEnvelope, HerdrEvent } from "../../src/herdr/types.js";

/**
 * Params the real herdr server requires, per method.
 *
 * Deliberately not exhaustive — it covers what this client actually calls, and
 * the point is to fail loudly on a shape the server would reject rather than to
 * reimplement its schema. Note `pane.*` takes `pane_id` while `agent.*` takes
 * `target`; that inconsistency is the whole reason this exists.
 */
const REQUIRED_PARAMS: Record<string, string[]> = {
  "pane.read": ["pane_id"],
  "pane.get": ["pane_id"],
  "pane.close": ["pane_id"],
  "agent.read": ["target"],
  "agent.prompt": ["target"],
  "agent.send_keys": ["target"],
  "agent.start": ["name", "kind", "pane_id"],
};

function missingParams(method: string, params: Record<string, unknown>): string | null {
  for (const key of REQUIRED_PARAMS[method] ?? []) {
    if (params[key] === undefined) return key;
  }
  return null;
}

/** Return this from a handler to accept the request and never answer it. */
export const NO_REPLY = Symbol("no-reply");

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * A herdr control socket good enough to test against: real Unix socket, real
 * ndjson framing, same request/response envelope.
 *
 * Testing the client against a stub object would not catch framing bugs — a
 * response split across chunks, two frames arriving together — which is exactly
 * the class of bug that shows up only under load.
 */
export class FakeHerdr {
  readonly socketPath: string;
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];

  #dir: string;
  #server: net.Server;
  #clients = new Set<net.Socket>();
  #handlers = new Map<string, Handler>();
  /** Sockets that issued events.subscribe and are awaiting pushes. */
  #subscribers = new Set<net.Socket>();

  private constructor() {
    this.#dir = mkdtempSync(path.join(tmpdir(), "fake-herdr-"));
    this.socketPath = path.join(this.#dir, "herdr.sock");
    this.#server = net.createServer((socket) => {
      this.#clients.add(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) this.#dispatch(socket, line);
          nl = buffer.indexOf("\n");
        }
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        this.#clients.delete(socket);
        this.#subscribers.delete(socket);
      });
    });
  }

  static async start(): Promise<FakeHerdr> {
    const fake = new FakeHerdr();
    await new Promise<void>((resolve) => fake.#server.listen(fake.socketPath, resolve));
    fake.on("ping", () => ({ type: "pong" }));
    return fake;
  }

  /** Register a response for a method. Return an Error to reply with a herdr error. */
  on(method: string, handler: Handler): this {
    this.#handlers.set(method, handler);
    return this;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** Push an event to every subscriber, as herdr would. */
  emitEvent(event: HerdrEvent): void {
    const envelope: EventEnvelope = { event: event.type as EventEnvelope["event"], data: event };
    this.#writeAll(JSON.stringify(envelope));
  }

  /** Send the ack that ends the connect-time replay. */
  emitSubscriptionStarted(): void {
    this.#writeAll(JSON.stringify({ id: "sub_1", result: { type: "subscription_started" } }));
  }

  /** Write a raw line — for malformed-frame tests. */
  emitRaw(line: string): void {
    this.#writeAll(line);
  }

  /** Drop all connections, simulating a herdr restart. */
  dropConnections(): void {
    for (const socket of this.#clients) socket.destroy();
    this.#clients.clear();
    this.#subscribers.clear();
  }

  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    rmSync(this.#dir, { recursive: true, force: true });
  }

  #writeAll(line: string): void {
    for (const socket of this.#subscribers) socket.write(`${line}\n`);
  }

  #dispatch(socket: net.Socket, line: string): void {
    let message: { id?: string; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id = "?", method = "", params = {} } = message;
    this.requests.push({ method, params });

    // Reject the same param shapes the real server rejects. Without this the
    // fake answers anything, and `pane.read` shipped for weeks sending
    // `target` where herdr requires `pane_id` — every read failed in
    // production while every test passed.
    const missing = missingParams(method, params);
    if (missing) {
      socket.write(
        `${JSON.stringify({
          id,
          error: { code: "invalid_request", message: `missing field \`${missing}\`` },
        })}\n`,
      );
      return;
    }

    if (method === "events.subscribe") {
      this.#subscribers.add(socket);
      return; // The test drives replay and the ack explicitly.
    }

    const handler = this.#handlers.get(method);
    if (!handler) {
      socket.write(
        `${JSON.stringify({ id, error: { code: "unknown_method", message: method } })}\n`,
      );
      return;
    }
    const result = handler(params);
    if (result === NO_REPLY) return;
    if (result instanceof Error) {
      // A `code` on the Error lets a test reproduce a specific herdr refusal;
      // without one, not_found stands in for "herdr said no".
      const code = (result as Error & { code?: string }).code ?? "not_found";
      socket.write(`${JSON.stringify({ id, error: { code, message: result.message } })}\n`);
      return;
    }
    socket.write(`${JSON.stringify({ id, result })}\n`);
  }
}
