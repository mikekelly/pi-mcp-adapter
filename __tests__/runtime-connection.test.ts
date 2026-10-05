import { describe, it, expect, vi } from "vitest";
import {
  leaseConnection,
  registerConnectionBridge,
  acquireMcpConnection,
} from "../runtime-connection.ts";
const fixture = () =>
  ({
    status: "connected",
    definition: { command: "node" },
    inFlight: 0,
    lastUsedAt: 0,
    client: {},
    transport: { onclose: vi.fn() },
  }) as any;
describe("trusted extension connection leases", () => {
  it("pins the existing connection and releases idempotently without closing it", () => {
    const c = fixture(),
      owner = new AbortController();
    const previous = c.transport.onclose;
    const lease = leaseConnection(c, owner.signal);
    expect(lease.client).toBe(c.client);
    expect(c.inFlight).toBe(1);
    lease.release();
    lease.release();
    expect(c.inFlight).toBe(0);
    expect(lease.signal.aborted).toBe(true);
    expect(c.transport.onclose).toBe(previous);
    expect(previous).not.toHaveBeenCalled();
  });
  it("disconnect and runtime shutdown invalidate all leases", () => {
    const c = fixture(),
      owner = new AbortController(),
      original = c.transport.onclose;
    const a = leaseConnection(c, owner.signal),
      b = leaseConnection(c, owner.signal);
    expect(c.inFlight).toBe(2);
    c.transport.onclose();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(c.inFlight).toBe(0);
    expect(original).toHaveBeenCalledOnce();
    const d = fixture();
    const lease = leaseConnection(d, owner.signal);
    owner.abort();
    expect(lease.signal.aborted).toBe(true);
    expect(d.inFlight).toBe(0);
  });
  it("rejects expired or disconnected owners", () => {
    const c = fixture(),
      owner = new AbortController();
    owner.abort();
    expect(() => leaseConnection(c, owner.signal)).toThrow();
    c.status = "closed";
    expect(() => leaseConnection(c, new AbortController().signal)).toThrow();
  });
  it("exposes an optional versioned bridge without starting connections at registration", async () => {
    const listeners = new Map();
    const pi = {
      events: {
        on: (n: string, f: unknown) => listeners.set(n, f),
        emit: (n: string, r: unknown) => listeners.get(n)?.(r),
      },
    } as any;
    await expect(acquireMcpConnection(pi, "test")).rejects.toThrow(
      "connection leases",
    );
    const c = fixture();
    const resolve = vi.fn(async () =>
      leaseConnection(c, new AbortController().signal),
    );
    registerConnectionBridge(pi, resolve);
    expect(resolve).not.toHaveBeenCalled();
    const lease = await acquireMcpConnection(pi, "test");
    expect(resolve).toHaveBeenCalledWith("test");
    lease.release();
  });
});
