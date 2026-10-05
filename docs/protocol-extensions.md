# Protocol extensions

A companion Pi extension can implement an additional MCP protocol capability using the adapter's existing server configuration, authentication and connection lifecycle. Register the capability's methods, then explicitly request its operations. Registration does not connect or subscribe to servers.

```ts
import { registerMcpProtocol } from 'pi-mcp-adapter';

const protocol = registerMcpProtocol(pi, {
  namespace: 'example',
  requests: ['example/list'],
  streams: ['example/stream'],
  notifications: ['notifications/example/active', 'notifications/example/item'],
});
const session = await protocol.connect('configured-server');
const catalog = await session.request('example/list', {});
// Validate the capability-specific result before using it.
const stream = session.openStream('example/stream', { name: 'chosen-item' }, (method, params) => {
  // Validate and render this capability's notifications in the companion.
});
await stream.sent; // Written to the server, not necessarily acknowledged.
const end = await stream.closed; // cancelled, ended, error, or disconnected
// Alternatively: await stream.cancel();
session.close();
protocol.dispose(); // Close its sessions and unregister the namespace.
```

Call registration after the adapter has loaded (for example on first use); an unavailable hook throws an actionable error for the companion to handle. Only one registration may own a namespace per adapter. Namespaces and method declarations are copied at registration. Requests/streams must belong to that namespace; notifications must use `notifications/<namespace>/...`. Core namespaces such as `tools`, `resources`, and `subscriptions` are reserved and cannot be registered. Ordinary tool calls continue through the adapter's tool-call API and its approval handling.

This API exposes no SDK client, transport, arbitrary send method, or handler replacement. `request` accepts only declared request methods and returns an ordinary SDK request result. `openStream` accepts only declared stream methods and delivers only declared notifications correlated to that stream through `params._meta["io.modelcontextprotocol/subscriptionId"]`. Unrelated traffic continues to the SDK. The adapter allocates request IDs, sends cancellation, and reports remote results/errors, server cancellation, transport closure, and session replacement. Consumer exceptions terminate only that consumer's stream. Parameters cannot override reserved `_meta` fields.

An operation prevents idle cleanup only while its request or stream is active. Counts belong to the exact connection and never transfer during reconnect. Closing a protocol session or disposing its registration cancels its work without closing the shared MCP client. Consumers must observe `session.signal` or `stream.closed` and explicitly reconnect after a disconnection; there is no automatic subscription or replay. A stream's `sent` promise confirms transmission only: acknowledgement validation, activation timeouts, heartbeat policy, and any agent wakeup belong to the companion protocol implementation.

An active Pi session and an enabled server in its effective configuration are required. Connection setup uses normal project trust, server approval, lazy connection, and runtime ownership checks. This is a trusted installed-extension API, not a sandbox for untrusted extension code. The method restrictions preserve the adapter's protocol and tool boundaries; they cannot constrain arbitrary code running in Pi's process. Companions own additional capability consent and payload validation, and should treat received content as external data.

The initial implementation supports **stdio**. The current SDK supports ordinary custom requests but lacks a generic long-lived extension stream primitive, so the adapter provides one internal router per transport. HTTP/SSE extension streams are rejected until their request lifetime and routing can be supported explicitly.

Across independently loaded Pi packages, use the synchronous event bus `pi-mcp-adapter:protocol:v1` with `{version: 1, definition}`. The adapter sets `result` to the mediated protocol handle or `error` to a registration error; an absent result/error means the hook is unavailable. This is also how `registerMcpProtocol` works. A companion can use the structural contract without importing another adapter instance.
