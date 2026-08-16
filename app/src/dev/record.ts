import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { defaultSocketPath } from "../herdr/client.js";
import { GLOBAL_SUBSCRIPTIONS } from "../herdr/types.js";

/**
 * Capture a live herdr event stream to an ndjson fixture.
 *
 * The test suite replays these through a fake socket, which means the projection
 * is verified against traffic herdr actually produced rather than against events
 * we imagined it produces. Record a session that includes the awkward cases —
 * an agent blocking, a pane moved between workspaces, a tab closed — because
 * those are the ones worth having fixtures for.
 *
 *   herdr-slack dev record app/test/fixtures/blocked-and-moved.ndjson
 */
export async function devRecord(
  outPath: string,
  socketPath = defaultSocketPath(),
): Promise<number> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath, { flags: "w" });

  let count = 0;
  const socket = net.createConnection(socketPath);
  let buffer = "";

  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({
        id: "rec_1",
        method: "events.subscribe",
        params: { subscriptions: GLOBAL_SUBSCRIPTIONS },
      })}\n`,
    );
    process.stderr.write(`recording to ${outPath} — Ctrl-C to stop\n`);
  });

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        out.write(`${line}\n`);
        count += 1;
        process.stderr.write(`\r${count} frames`);
      }
      nl = buffer.indexOf("\n");
    }
  });

  socket.on("error", (error) => {
    process.stderr.write(`\nherdr socket error: ${error.message}\n`);
  });

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    socket.on("close", stop);
  });

  socket.destroy();
  await new Promise<void>((resolve) => out.end(resolve));
  process.stderr.write(`\nwrote ${count} frames to ${outPath}\n`);
  return 0;
}
