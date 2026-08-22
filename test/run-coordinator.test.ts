import { test } from "node:test";
import assert from "node:assert/strict";
import { RunCoordinator, renderTemplate } from "../src/run-coordinator.ts";
import { RunStore, createRun } from "../src/run-state.ts";
import type { RpcAdapter, StatusResult, SpawnResult } from "../src/rpc-adapter.ts";
import { makeIr } from "./support.ts";

const TERMINAL = new Set(["complete", "failed", "stopped"]);

/** Deterministic mock adapter: status state sequence per runId. */
class MockAdapter {
  state: RpcAdapter["state"] = "available";
  capabilities = { status: true, asyncSpawn: true, interrupt: true, stop: true } as const;
  spawned: Array<{ agent: string; task: string; context: string; cwd: string }> = [];
  private sequence: Array<"queued" | "running" | "complete" | "failed" | "stopped"> = [];
  private queueFor = new Map<string, string[]>();
  interruptCalled = 0;
  stopCalled = 0;
  stopIds: string[] = [];

  constructor(sequence: MockAdapter["sequence"]) {
    this.sequence = sequence;
  }

  private next(runId: string): string {
    const q = this.queueFor.get(runId) ?? [];
    if (q.length === 0) {
      const s = this.sequence[Math.min(this.sequence.length - 1, 0)] ?? "complete";
      q.push(s);
      this.queueFor.set(runId, q);
    }
    return q.shift() ?? "complete";
  }

  async spawn(params: { agent: string; task: string; context: "fresh" | "fork"; cwd: string }): Promise<SpawnResult> {
    this.spawned.push(params);
    const runId = `r${this.spawned.length}`;
    return { runId, asyncDir: `/tmp/x/${runId}` };
  }

  async status(_params: { runId?: string; id?: string; dir?: string }): Promise<StatusResult> {
    const runId = _params.runId ?? "r1";
    const state = this.next(runId);
    return {
      state: state as StatusResult["state"],
      runId,
      sessionId: "s",
      totalTokens: 10,
      totalCost: 0.01,
    };
  }

  async interrupt(): Promise<void> {
    this.interruptCalled += 1;
  }

  async stop(params: { runId: string }): Promise<{ runId: string; asyncDir: string; previousState: string; state: "stopping" }> {
    this.stopCalled += 1;
    this.stopIds.push(params.runId);
    return { runId: "r1", asyncDir: "/x", previousState: "running", state: "stopping" };
  }
}

function setup(sequence: MockAdapter["sequence"] = ["complete"], overrides: Record<string, unknown> = {}) {
  const adapter = new MockAdapter(sequence);
  const store = new RunStore();
  const messages: string[] = [];
  const coordinator = new RunCoordinator({
    adapter: adapter as unknown as RpcAdapter,
    runStore: store,
    sendUserMessage: (t: string) => void messages.push(t),
    cwd: "/proj",
    pollIntervalMs: 5,
  });
  return { adapter, store, messages, coordinator, overrides };
}

function prep(store: RunStore, name = "wf", irOverride?: unknown) {
  const ir = makeIr(irOverride as never) ?? makeIr();
  const run = createRun(name, ir, { topic: "x" });
  store.add(run);
  return run;
}

test("sequential phase completes; result message emitted", async () => {
  const { adapter, store, messages, coordinator } = setup(["complete"]);
  const run = prep(store);
  const res = await coordinator.run(run);
  assert.equal(res.status, "completed");
  assert.equal(res.phaseIndex, 0); // single phase: last completed phase index is 0
  assert.equal(adapter.spawned.length, 1);
  assert.equal(adapter.spawned[0].context, "fresh");
  assert.equal(adapter.spawned[0].cwd, "/proj");
  const msg = JSON.parse(messages[0]);
  assert.equal(msg.type, "pi-workflows:run-result");
  assert.equal(msg.status, "completed");
  assert.equal(messages.length, 1);
});

test("subagent failure fails the run and emits error result", async () => {
  const { store, messages, coordinator } = setup(["failed"]);
  const run = prep(store);
  const res = await coordinator.run(run);
  assert.equal(res.status, "failed");
  assert.ok(res.error?.includes("ended failed"));
  const msg = JSON.parse(messages[0]);
  assert.equal(msg.status, "failed");
  assert.ok(msg.error);
});

test("RPC unavailable disables runs cleanly", async () => {
  const { store, messages, coordinator, adapter } = setup(["complete"]);
  adapter.state = "unavailable";
  const run = prep(store);
  const res = await coordinator.run(run);
  assert.equal(res.status, "failed");
  assert.ok(res.error?.includes("unavailable"));
  const msg = JSON.parse(messages[0]);
  assert.equal(msg.status, "failed");
});

test("gate success passes when outputKey present", async () => {
  const ir = makeIr({
    phases: [
      { type: "sequential", steps: [{ agent: "a", task: "one", outputKey: "out1" }] },
      { type: "gate", condition: { type: "success", outputKey: "out1" }, skipToPhase: 0 },
      { type: "sequential", steps: [{ agent: "b", task: "three" }] },
    ],
  });
  const { adapter, store, coordinator } = setup(["complete"]);
  const run = prep(store, "wf", ir);
  const res = await coordinator.run(run);
  assert.equal(res.status, "completed");
  assert.equal(adapter.spawned.length, 2);
  assert.ok(res.outputs.out1);
});

test("gate fail jumps to skipToPhase", async () => {
  const ir = makeIr({
    phases: [
      { type: "sequential", steps: [{ agent: "a", task: "one" }] }, // no outputKey
      { type: "gate", condition: { type: "success", outputKey: "missing" }, skipToPhase: 2 },
      { type: "sequential", steps: [{ agent: "b", task: "three" }] },
    ],
  });
  const { adapter, store, coordinator } = setup(["complete"]);
  const run = prep(store, "wf", ir);
  const res = await coordinator.run(run);
  assert.equal(res.status, "completed");
  assert.equal(res.phaseIndex, 2); // sequential(0), gate(1), sequential(2): last completed phase
  assert.equal(adapter.spawned.length, 2); // phase 0 ran; gate jump → phase 2 ran
});

test("contains gate rejected at runtime", async () => {
  const ir = makeIr({
    phases: [
      { type: "sequential", steps: [{ agent: "a", task: "one", outputKey: "out1" }] },
      { type: "gate", condition: { type: "contains", outputKey: "out1", pattern: "done" }, skipToPhase: 0 },
    ],
  });
  const { store, coordinator, messages } = setup(["complete"]);
  const run = prep(store, "wf", ir);
  const res = await coordinator.run(run);
  assert.equal(res.status, "failed");
  assert.ok(res.error?.includes("contains gate not supported"));
  assert.ok(JSON.parse(messages[0]).error.includes("contains gate not supported"));
});

test("loop until success exits after one round when output recorded", async () => {
  const ir = makeIr({
    phases: [
      {
        type: "loop",
        until: { type: "success" },
        maxRounds: 5,
        steps: [{ agent: "a", task: "round", outputKey: "roundout" }],
      },
    ],
  });
  const { adapter, store, coordinator } = setup(["complete"]);
  const run = prep(store, "wf", ir);
  const res = await coordinator.run(run);
  assert.equal(res.status, "completed");
  assert.equal(adapter.spawned.length, 1); // outputs present → exit after round 1
});

test("loop maxRounds exceeded fails the run", async () => {
  const ir = makeIr({
    phases: [
      {
        type: "loop",
        until: { type: "success" }, // steps never write outputs → never met
        maxRounds: 2,
        steps: [{ agent: "a", task: "round" }],
      },
    ],
  });
  const { adapter, store, coordinator } = setup(["complete"]);
  const run = prep(store, "wf", ir);
  const res = await coordinator.run(run);
  assert.equal(res.status, "failed");
  assert.ok(res.error?.includes("maxRounds"));
  assert.equal(adapter.spawned.length, 2);
});

test("maxAgents limit enforced", async () => {
  const ir = makeIr({
    phases: [{ type: "sequential", steps: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] }],
    limits: { maxAgents: 1 },
  });
  const { store, coordinator } = setup(["complete"]);
  const run = prep(store, "wf", ir);
  const res = await coordinator.run(run);
  assert.equal(res.status, "failed");
  assert.ok(res.error?.includes("maxAgents limit reached"));
});

test("parallel phase runs all steps concurrently", async () => {
  const ir = makeIr({
    phases: [
      {
        type: "parallel",
        steps: [
          { agent: "a", task: "1", outputKey: "p1" },
          { agent: "b", task: "2", outputKey: "p2" },
        ],
      },
    ],
  });
  const { adapter, store, coordinator } = setup(["complete"]);
  const run = prep(store, "wf", ir);
  const res = await coordinator.run(run);
  assert.equal(res.status, "completed");
  assert.equal(adapter.spawned.length, 2);
  assert.ok(res.outputs.p1 && res.outputs.p2);
});

test("stop only targets subagents owned by requested run", async () => {
  const { store, coordinator, adapter } = setup(["complete"]);
  const runA = prep(store, "a");
  const runB = prep(store, "b");
  store.update(runA.runId, { status: "running", subagentRunIds: ["a-agent"], subagentRuns: [{ runId: "a-agent", phaseIndex: 0, stepIndex: 0 }] });
  store.update(runB.runId, { status: "running", subagentRunIds: ["b-agent"], subagentRuns: [{ runId: "b-agent", phaseIndex: 0, stepIndex: 0 }] });
  (coordinator as unknown as { activeSubagents: Set<string> }).activeSubagents.add("a-agent");
  (coordinator as unknown as { activeSubagents: Set<string> }).activeSubagents.add("b-agent");
  await coordinator.stop(runA.runId);
  assert.deepEqual(adapter.stopIds, ["a-agent"]);
  assert.equal(store.get(runB.runId)?.status, "running");
});

test("spawn records phase and step ownership metadata", async () => {
  const ir = makeIr({ phases: [{ type: "sequential", steps: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] }] });
  const { store, coordinator } = setup(["complete"]);
  const run = prep(store, "wf", ir);
  await coordinator.run(run);
  assert.deepEqual(store.get(run.runId)?.subagentRuns.map((r) => [r.phaseIndex, r.stepIndex]), [[0, 0], [0, 1]]);
});

test("stop guard rejects non-running runs", async () => {
  const { store, coordinator } = setup(["complete"]);
  const run = prep(store);
  await assert.rejects(() => coordinator.stop(run.runId), /not running/);
});

test("coordinator.pause reports RPC v1 resume limitation", async () => {
  const { store, coordinator } = setup(["complete"]);
  const run = prep(store);
  store.update(run.runId, { status: "running" });
  await assert.rejects(() => coordinator.pause(run.runId), /no resume method/);
  assert.equal(store.get(run.runId)?.status, "running");
});

test("renderTemplate substitutes {{keys}} only", () => {
  assert.equal(renderTemplate("analyze {{topic}} now", { topic: "dogs" }), "analyze dogs now");
  assert.equal(renderTemplate("{{ missing }} stays", { a: 1 }), "{{ missing }} stays");
  assert.equal(renderTemplate("{{n}}={{n}}", { n: 2 }), "2=2");
  assert.equal(renderTemplate("no vars", {}), "no vars");
});

test("task template rendered at spawn time", async () => {
  const ir = makeIr({
    phases: [{ type: "sequential", steps: [{ agent: "a", task: "work on {{topic}}" }] }],
  });
  const { adapter, store, coordinator } = setup(["complete"]);
  const run = prep(store, "wf", ir);
  await coordinator.run(run);
  assert.equal(adapter.spawned[0].task, "work on x");
});