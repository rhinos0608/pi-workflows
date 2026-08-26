import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RpcAdapter,
  makeRequest,
  RPC_READY_EVENT,
  RPC_REQUEST_EVENT,
  RPC_REPLY_EVENT,
  RPC_DETECTION_TIMEOUT_MS,
  type StatusResult,
} from "../src/rpc-adapter.ts";
import { createMockEventBus } from "./support.ts";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("detection lifecycle: ready → ping → available", async () => {
  const { bus, trigger } = createMockEventBus();
  const adapter = new RpcAdapter(bus);
  adapter.detect();
  assert.equal(adapter.state, "undetected");

  // ready event arrives; adapter pings; our test peer answers the reply.
  const readyData = { version: 1 as const, methods: ["ping", "spawn", "result"], capabilities: { status: true, spawn: true, result: true, asyncSpawn: true, interrupt: true, stop: true }, session: { cwd: "/x", sessionId: "s1", sessionFile: "/x/s.json" } };
  bus.on(RPC_REQUEST_EVENT, (raw) => {
    const req = raw as { requestId: string; method: string };
    if (req.method === "ping") {
      // reply asynchronously to exercise the promise path
      setTimeout(() => {
        trigger(RPC_REPLY_EVENT, { version: 1, requestId: req.requestId, success: true, data: readyData });
      }, 5);
    }
  });

  trigger(RPC_READY_EVENT, readyData);
  await wait(20);
  assert.equal(adapter.state, "available");
  assert.deepEqual(adapter.capabilities, readyData.capabilities);
});

test("spawn emits correct request envelope with async:true", async () => {
  const { bus, trigger, emitted } = createMockEventBus();
  const adapter = new RpcAdapter(bus);
  adapter.detect();
  const pingData = { version: 1 as const, methods: ["ping", "spawn", "result"], capabilities: { status: true, spawn: true, result: true, asyncSpawn: true, interrupt: true, stop: true }, session: { cwd: "/x", sessionId: "s", sessionFile: "/s.json" } };
  bus.on(RPC_REQUEST_EVENT, (raw) => {
    const req = raw as { method: string; requestId: string };
    trigger(RPC_REPLY_EVENT, {
      version: 1,
      requestId: req.requestId,
      success: true,
      data: req.method === "ping" ? pingData : { text: "spawned", details: { asyncId: "run-1", asyncDir: "/tmp/pi-subagents/run-1" } },
    });
  });
  trigger(RPC_READY_EVENT, pingData);
  await wait(10);

  const spawn = await adapter.spawn({ agent: "worker", task: "do it", context: "fresh", cwd: "/proj" });
  assert.equal(spawn.runId, "run-1");
  const reqs = emitted.filter((e) => e.channel === RPC_REQUEST_EVENT).map((e) => e.data as Record<string, unknown>);
  const req = reqs[reqs.length - 1]; // last request = spawn (ping first)
  assert.equal(req.method, "spawn");
  assert.deepEqual(req.source, { extension: "pi-workflows" });
  assert.deepEqual(
    (req as unknown as { params: Record<string, unknown> }).params,
    { agent: "worker", task: "do it", context: "fresh", cwd: "/proj", async: true }
  );
});

test("spawn rejects when unavailable", async () => {
  const { bus } = createMockEventBus();
  const adapter = new RpcAdapter(bus);
  adapter.detect();
  // async wrapper: a synchronous throw inside the factory is not a rejection
  await assert.rejects(async () => adapter.spawn({ agent: "a", task: "t", context: "fresh", cwd: "/" }), /unavailable/);
});

test("detection timeout without ready event → unavailable", async () => {
  const { bus } = createMockEventBus();
  const adapter = new RpcAdapter(bus);
  adapter.detect();
  assert.equal(adapter.state, "undetected");
  await wait(RPC_DETECTION_TIMEOUT_MS + 50);
  assert.equal(adapter.state, "unavailable");
  assert.throws(() => adapter.ping(), /unavailable/);
});

test("reply timeout rejects a hung method call", { timeout: 15_000 }, async () => {
  const { bus, trigger } = createMockEventBus();
  const adapter = new RpcAdapter(bus);
  adapter.detect();
  const pingData = { version: 1 as const, methods: ["ping", "spawn", "result"], capabilities: { status: true, spawn: true, result: true, asyncSpawn: true, interrupt: true, stop: true }, session: { cwd: "/", sessionId: "s", sessionFile: "/s.json" } };
  bus.on(RPC_REQUEST_EVENT, (raw) => {
    const req = raw as { method: string; requestId: string };
    if (req.method === "ping") {
      trigger(RPC_REPLY_EVENT, { version: 1, requestId: req.requestId, success: true, data: pingData });
      return;
    }
    // status never answered
  });
  trigger(RPC_READY_EVENT, pingData);
  await wait(10);
  await assert.rejects(() => adapter.status({ runId: "x" }), /timed out/);
});

test("stop rejects invalid state from RPC with rpc_error", async () => {
  const { bus, trigger } = createMockEventBus();
  const adapter = new RpcAdapter(bus);
  adapter.detect();
  const pingData = { version: 1 as const, methods: ["ping", "spawn", "result", "stop"], capabilities: { status: true, spawn: true, result: true, asyncSpawn: true, interrupt: true, stop: true }, session: { cwd: "/", sessionId: "s", sessionFile: "/s.json" } };
  bus.on(RPC_REQUEST_EVENT, (raw) => {
    const req = raw as { method: string; requestId: string };
    trigger(RPC_REPLY_EVENT, {
      version: 1,
      requestId: req.requestId,
      success: req.method === "ping",
      data: req.method === "ping" ? pingData : undefined,
      error: req.method === "ping" ? undefined : { code: "invalid_state", message: "run is not running" },
    });
  });
  trigger(RPC_READY_EVENT, pingData);
  await wait(10);
  await assert.rejects(async () => adapter.stop({ runId: "x" }), /invalid_state/);
});

test("result rejects malformed and mismatched terminal responses", async (t) => {
  const pingData = {
    version: 1 as const,
    methods: ["ping", "spawn", "result"],
    capabilities: { status: true, spawn: true, result: true, asyncSpawn: true, interrupt: true, stop: true },
    session: { cwd: "/", sessionId: "s", sessionFile: "/s.json" },
  };
  for (const [name, result] of [
    ["malformed", { runId: "r1", ready: true, state: "complete" }],
    ["mismatched", { runId: "other", ready: true, state: "complete", outcome: "success", output: "done", outputAvailable: true, outputTruncated: false }],
  ] as const) {
    await t.test(name, async () => {
      const { bus, trigger } = createMockEventBus();
      const adapter = new RpcAdapter(bus);
      adapter.detect();
      bus.on(RPC_REQUEST_EVENT, (raw) => {
        const req = raw as { method: string; requestId: string };
        trigger(RPC_REPLY_EVENT, { version: 1, requestId: req.requestId, success: true, data: req.method === "ping" ? pingData : result });
      });
      trigger(RPC_READY_EVENT, pingData);
      await wait(5);
      await assert.rejects(() => adapter.result({ runId: "r1" }), name === "malformed" ? /malformed/ : /mismatch/);
    });
  }
});

test("adapter unavailable when required spawn/result capabilities are absent", async (t) => {
  for (const [name, methods, capabilities] of [
    ["spawn method", ["ping", "result"], { status: true, spawn: true, result: true, asyncSpawn: true, interrupt: true, stop: true }],
    ["result capability", ["ping", "spawn", "result"], { status: true, spawn: true, result: false, asyncSpawn: true, interrupt: true, stop: true }],
    ["async spawn capability", ["ping", "spawn", "result"], { status: true, spawn: true, result: true, asyncSpawn: false, interrupt: true, stop: true }],
  ] as const) {
    await t.test(name, async () => {
      const { bus, trigger } = createMockEventBus();
      const adapter = new RpcAdapter(bus);
      adapter.detect();
      const data = { version: 1 as const, methods, capabilities, session: { cwd: "/", sessionId: "s", sessionFile: "/s.json" } };
      bus.on(RPC_REQUEST_EVENT, (raw) => {
        const req = raw as { requestId: string };
        trigger(RPC_REPLY_EVENT, { version: 1, requestId: req.requestId, success: true, data });
      });
      trigger(RPC_READY_EVENT, data);
      await wait(5);
      assert.equal(adapter.state, "unavailable");
    });
  }
});

test("makeRequest envelope shape", () => {
  const req = makeRequest("status", { runId: "r1" });
  assert.equal(req.version, 1);
  assert.equal(req.method, "status");
  assert.ok(req.requestId.length > 0);
  assert.ok(!req.requestId.includes("\n"));
  assert.deepEqual(req.source, { extension: "pi-workflows" });
});

test("reset returns to undetected and stops detection timer", async () => {
  const { bus } = createMockEventBus();
  const adapter = new RpcAdapter(bus);
  adapter.detect();
  adapter.reset();
  assert.equal(adapter.state, "undetected");
  await wait(RPC_DETECTION_TIMEOUT_MS + 30);
  assert.equal(adapter.state, "undetected"); // timer cleared; stays undetected
});

test("status result shape roundtrips", () => {
  const st: StatusResult = { state: "running", runId: "r", sessionId: "s", totalTokens: 100, totalCost: 0.01 };
  assert.equal(st.state, "running");
});