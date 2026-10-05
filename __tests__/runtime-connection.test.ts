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
    expect(c.activeLeases).toBe(1);
    lease.release();
    lease.release();
    expect(c.activeLeases).toBe(0);
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
    expect(c.activeLeases).toBe(2);
    c.transport.onclose();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(c.activeLeases).toBe(0);
    expect(original).toHaveBeenCalledOnce();
    const d = fixture();
    const lease = leaseConnection(d, owner.signal);
    owner.abort();
    expect(lease.signal.aborted).toBe(true);
    expect(d.activeLeases).toBe(0);
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

it("restores the original close handler when leases are released out of order", () => {
  const c = fixture();
  const original = c.transport.onclose;
  const owner = new AbortController();
  const first = leaseConnection(c, owner.signal);
  const second = leaseConnection(c, owner.signal);
  first.release();
  second.release();
  expect(c.transport.onclose).toBe(original);
});

it("leaves in-flight tool accounting unchanged and keeps other owners leased", () => {
  const c = fixture();
  c.inFlight = 3;
  const firstOwner = new AbortController();
  const otherOwner = new AbortController();
  const first = leaseConnection(c, firstOwner.signal);
  const second = leaseConnection(c, otherOwner.signal);
  firstOwner.abort();
  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(false);
  expect(c.activeLeases).toBe(1);
  expect(c.inFlight).toBe(3);
  second.release();
  expect(c.activeLeases).toBe(0);
  expect(c.inFlight).toBe(3);
});

it("does not overwrite a close handler subsequently installed by another consumer", () => {
  const c = fixture();
  const original = c.transport.onclose;
  const lease = leaseConnection(c, new AbortController().signal);
  const leasedClose = c.transport.onclose;
  const outer = vi.fn(() => leasedClose());
  c.transport.onclose = outer;
  lease.release();
  expect(c.transport.onclose).toBe(outer);
  c.transport.onclose();
  expect(original).toHaveBeenCalledOnce();
  expect(c.activeLeases).toBe(0);
});

it("invalidates every lease even when the prior close handler throws", () => {
  const c = fixture();
  c.transport.onclose = () => {
    throw new Error("SDK close failure");
  };
  const a = leaseConnection(c, new AbortController().signal);
  const b = leaseConnection(c, new AbortController().signal);
  expect(() => c.transport.onclose()).toThrow("SDK close failure");
  expect(a.signal.aborted).toBe(true);
  expect(b.signal.aborted).toBe(true);
  expect(c.activeLeases).toBe(0);
});

it.each([
  [{ command: "node" }, "stdio"],
  [{ url: "https://example.test/mcp" }, "http"],
  [{ socket: "/tmp/mcp.sock" }, "socket"],
])("reports the configured transport kind", (definition, kind) => {
  const c = fixture();
  c.definition = definition;
  const lease = leaseConnection(c, new AbortController().signal);
  expect(lease.transportKind).toBe(kind);
  lease.release();
});

it("validates bridge requests, preserves existing answers, and propagates resolver failures", async () => {
  let listener!: (raw: unknown) => void;
  const pi = {
    events: {
      on: (_name: string, fn: typeof listener) => {
        listener = fn;
      },
    },
  } as any;
  const resolve = vi.fn(async () => {
    throw new Error("connect failed");
  });
  registerConnectionBridge(pi, resolve);
  for (const raw of [null, undefined, 1, [], "bad"])
    expect(() => listener(raw)).not.toThrow();
  for (const raw of [
    { version: 2, name: "test" },
    { version: 1, name: " " },
    { version: 1, name: 4 },
  ]) {
    const request = raw as typeof raw & { result?: Promise<unknown> };
    listener(request);
    await expect(request.result).rejects.toThrow(
      "Invalid MCP connection lease request",
    );
  }
  const prefilled = {
    version: 1,
    name: "test",
    result: Promise.resolve("already handled"),
  };
  listener(prefilled);
  expect(resolve).not.toHaveBeenCalled();
  await expect(prefilled.result).resolves.toBe("already handled");
  const valid = { version: 1, name: "test" } as {
    version: number;
    name: string;
    result?: Promise<unknown>;
  };
  listener(valid);
  await expect(valid.result).rejects.toThrow("connect failed");
  expect(resolve).toHaveBeenCalledOnce();
});
