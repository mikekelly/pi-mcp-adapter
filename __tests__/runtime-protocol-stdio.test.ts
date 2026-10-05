import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
const protocolSession = (connection: any, signal: AbortSignal) =>
  createProtocolSession(connection, signal, {
    namespace: "demo",
    requests: ["demo/list"],
    streams: ["demo/stream"],
    notifications: [],
  });

const fixture = fileURLToPath(
  new URL("./fixtures/delayed-mcp-server.mjs", import.meta.url),
);
const definition = { command: process.execPath, args: [fixture] };

describe("protocol operations on real stdio transports", () => {
  it("shares tools, prevents idle cleanup, and invalidates on reconnect without pinning the replacement", async () => {
    const manager = new McpServerManager(process.cwd());
    const owner = new AbortController();
    try {
      const connection = await manager.connect("demo", definition);
      const session = protocolSession(connection, owner.signal);
      const stream = session.openStream("demo/stream", {}, () => {});
      await stream.sent;
      connection.lastUsedAt = 0;
      expect(manager.isIdle("demo", 100)).toBe(false);
      const result = await connection.client.callTool({
        name: "reload_identity",
        arguments: {},
      });
      expect(result.content).toEqual([
        { type: "text", text: "fixture evidence visible to the model" },
      ]);
      const replacement = await manager.reconnect(
        "demo",
        definition,
        connection,
      );
      expect(replacement).not.toBe(connection);
      expect(session.signal.aborted).toBe(true);
      replacement.lastUsedAt = 0;
      expect(manager.isIdle("demo", 100)).toBe(true);
      expect(replacement.inFlight).toBe(0);
      const currentSession = protocolSession(replacement, owner.signal);
      const currentStream = currentSession.openStream(
        "demo/stream",
        {},
        () => {},
      );
      await currentStream.sent;
      session.close(); // An old consumer must not release the new transport's operation.
      expect(manager.isIdle("demo", 100)).toBe(false);
      currentSession.close();
      replacement.lastUsedAt = 0;
      expect(manager.isIdle("demo", 100)).toBe(true);
      expect((await replacement.client.listTools()).tools).toHaveLength(1);
      const closingSession = protocolSession(replacement, owner.signal);
      await manager.close("demo");
      expect(closingSession.signal.aborted).toBe(true);
    } finally {
      owner.abort();
      await manager.closeAll();
    }
  });
});
