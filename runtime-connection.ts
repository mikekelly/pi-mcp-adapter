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

export function leaseConnection(
  connection: ServerConnection,
  owner: AbortSignal,
): McpConnectionLease {
  if (owner.aborted || connection.status !== "connected")
    throw new Error("MCP connection is unavailable");
  const controller = new AbortController();
  const transport = connection.transport;
  const previousClose = transport.onclose;
  let released = false;
  connection.inFlight++;
  const release = () => {
    if (released) return;
    released = true;
    connection.inFlight = Math.max(0, connection.inFlight - 1);
    connection.lastUsedAt = Date.now();
    owner.removeEventListener("abort", release);
    if (transport.onclose === onclose) transport.onclose = previousClose;
    controller.abort(new Error("MCP connection lease ended"));
  };
  const onclose = () => {
    release();
    previousClose?.();
  };
  transport.onclose = onclose;
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
    if (!raw || typeof raw !== "object") return;
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
