import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { McpServerManager } from "../server-manager.ts";
import { leaseConnection } from "../runtime-connection.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/delayed-mcp-server.mjs", import.meta.url),
);
const definition = { command: process.execPath, args: [fixture] };

describe("connection leases on real stdio transports", () => {
  it("shares tools, prevents idle cleanup, and invalidates on reconnect without pinning the replacement", async () => {
    const manager = new McpServerManager(process.cwd());
    const owner = new AbortController();
    try {
      const connection = await manager.connect("demo", definition);
      const lease = leaseConnection(connection, owner.signal);
      expect(lease.transportKind).toBe("stdio");
      connection.lastUsedAt = 0;
      expect(manager.isIdle("demo", 100)).toBe(false);
      const result = await lease.client.callTool({
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
      expect(lease.signal.aborted).toBe(true);
      replacement.lastUsedAt = 0;
      expect(manager.isIdle("demo", 100)).toBe(true);
      expect(replacement.inFlight).toBe(0);
      const currentLease = leaseConnection(replacement, owner.signal);
      lease.release(); // An old consumer must not release the new transport's lease.
      expect(manager.isIdle("demo", 100)).toBe(false);
      currentLease.release();
      replacement.lastUsedAt = 0;
      expect(manager.isIdle("demo", 100)).toBe(true);
      expect((await replacement.client.listTools()).tools).toHaveLength(1);
      const closingLease = leaseConnection(replacement, owner.signal);
      await manager.close("demo");
      expect(closingLease.signal.aborted).toBe(true);
    } finally {
      owner.abort();
      await manager.closeAll();
    }
  });
});
