# Connection leases for trusted Pi extensions

The optional `acquireMcpConnection(pi, name)` export gives an installed, trusted extension access to a configured server's existing client and transport. It adds no model-facing tools or startup connections. The adapter remains responsible for configuration trust, auth and process ownership.

```ts
import { acquireMcpConnection } from '@realmikekelly/pi-mcp-adapter';

const lease = await acquireMcpConnection(pi, 'configured-server');
try {
  // Implement an additional protocol capability using lease.client/transport.
  // Check lease.transportKind if the capability supports only some transports.
  // Observe lease.signal; it aborts when the connection or session ends.
} finally {
  lease.release();
}
```

A lease increments the existing in-flight count to keep the connection alive. Release is idempotent and does not close the shared client. An active Pi session and an enabled server in its effective config are required; connection creation uses the adapter's normal lazy-connect path and runtime ownership guards.

Extensions must use the existing adapter tool-call API for tool execution so approval and output handling remain enforced. A raw connection lease is a trusted host-extension API, never a capability to expose directly to model-generated code. Consumers own additional protocol schemas, notification routing, cancellation and user consent. Chain unrelated transport messages to the previous handler and restore owned handlers on release.

The cross-package implementation uses the synchronous Pi event bus event `pi-mcp-adapter:connection:v1`: emit a request `{version: 1, name}`; the adapter sets `result` to a promise of the lease. An absent result means the hook is unavailable. This avoids requiring both extensions to load the same module instance.
