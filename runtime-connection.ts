/** Trusted Pi extension access to a session-owned MCP connection; never a model tool. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Client, Transport } from "@modelcontextprotocol/client";
import type { ServerConnection } from "./server-manager.ts";

export const MCP_CONNECTION_EVENT = "pi-mcp-adapter:connection:v1";
export interface McpConnectionLease {
  readonly client: Client;
  readonly transport: Transport;
  readonly transportKind: "stdio" | "http" | "socket";
  /** Aborted on release, disconnect, or session replacement. */
  readonly signal: AbortSignal;
  release(): void;
}
interface ConnectionRequest {
  version: 1;
  name: string;
  result?: Promise<McpConnectionLease>;
}

// One close observer per transport, regardless of lease count or release order.
interface LeaseGroup {
  releases: Set<() => void>;
  closing: boolean;
  previousClose: Transport["onclose"];
  onclose: () => void;
}
const groups = new WeakMap<Transport, LeaseGroup>();

export function leaseConnection(
  connection: ServerConnection,
  owner: AbortSignal,
): McpConnectionLease {
  const transport = connection.transport;
  if (
    owner.aborted ||
    connection.status !== "connected" ||
    groups.get(transport)?.closing
  ) {
    throw new Error("MCP connection is unavailable");
  }
  let group = groups.get(transport);
  if (!group) {
    const created: LeaseGroup = {
      releases: new Set(),
      closing: false,
      previousClose: transport.onclose,
      onclose: () => {
        created.closing = true;
        try {
          created.previousClose?.();
        } finally {
          for (const release of [...created.releases]) release();
        }
      },
    };
    group = created;
    groups.set(transport, group);
    transport.onclose = group.onclose;
  }
  const controller = new AbortController();
  const activeGroup = group;
  let released = false;
  // Unlike in-flight tool calls, leases belong to this exact transport and must
  // not transfer to a replacement connection during reconnect.
  connection.activeLeases = (connection.activeLeases ?? 0) + 1;
  const release = () => {
    if (released) return;
    released = true;
    connection.activeLeases = connection.activeLeases! - 1;
    connection.lastUsedAt = Date.now();
    owner.removeEventListener("abort", release);
    activeGroup.releases.delete(release);
    if (activeGroup.releases.size === 0) {
      if (transport.onclose === activeGroup.onclose)
        transport.onclose = activeGroup.previousClose;
      groups.delete(transport);
    }
    controller.abort(new Error("MCP connection lease ended"));
  };
  activeGroup.releases.add(release);
  owner.addEventListener("abort", release, { once: true });
  return {
    client: connection.client,
    transport,
    transportKind: connection.definition.command
      ? "stdio"
      : connection.definition.socket
        ? "socket"
        : "http",
    signal: controller.signal,
    release,
  };
}

export function registerConnectionBridge(
  pi: ExtensionAPI,
  resolve: (name: string) => Promise<McpConnectionLease>,
): void {
  pi.events.on(MCP_CONNECTION_EVENT, (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const request = raw as ConnectionRequest;
    if (request.result !== undefined) return;
    request.result = (async () => {
      if (
        request.version !== 1 ||
        typeof request.name !== "string" ||
        !request.name.trim()
      ) {
        throw new Error("Invalid MCP connection lease request");
      }
      return resolve(request.name);
    })();
  });
}

/** Keeps a configured server alive until release. Does not own or close the shared client.
 * Trusted extensions must use the tool-call API for tools so adapter approvals remain enforced.
 * Protocol extensions own their schemas, notification routing, cancellation and consent.
 */
export async function acquireMcpConnection(
  pi: ExtensionAPI,
  name: string,
): Promise<McpConnectionLease> {
  const request: ConnectionRequest = { version: 1, name };
  pi.events.emit(MCP_CONNECTION_EVENT, request);
  if (!request.result)
    throw new Error("pi-mcp-adapter does not expose connection leases");
  return request.result;
}
