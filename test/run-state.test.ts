import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRun,
  applyTransition,
  RunStore,
  ALLOWED_TRANSITIONS,
  boundOutputs,
  MAX_OUTPUTS_KEYS,
  MAX_OUTPUT_VALUE_LEN,
} from "../src/run-state.ts";
import { makeIr } from "./support.ts";

function run() {
  return createRun("wf", makeIr({ name: "wf" }), { topic: "x" });
}

test("valid lifecycle completes", () => {
  let r = run();
  r = applyTransition(r, "start");
  assert.equal(r.status, "running");
  r = applyTransition(r, "phase_complete", { phaseIndex: 1 });
  assert.equal(r.status, "running");
  r = applyTransition(r, "complete");
  assert.equal(r.status, "completed");
  assert.ok(r.endedAt !== undefined);
  assert.ok(r.elapsedMs !== undefined);
});

test("invalid transitions throw", () => {
  const r = run(); // pending
  assert.throws(() => applyTransition(r, "complete"));
  const started = applyTransition(r, "start");
  assert.throws(() => applyTransition(started, "start"));
  assert.throws(() => applyTransition(started, "resume"));
  const paused = applyTransition(started, "pause");
  assert.equal(paused.status, "paused");
  assert.throws(() => applyTransition(paused, "complete"));
  const stopped = applyTransition(paused, "stop");
  assert.equal(stopped.status, "stopped");
  assert.throws(() => applyTransition(stopped, "resume"));
});

test("allowed transitions map is exhaustive for all statuses", () => {
  for (const s of ["pending", "running", "paused", "completed", "failed", "stopped"]) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[s as keyof typeof ALLOWED_TRANSITIONS]));
  }
  assert.deepEqual(ALLOWED_TRANSITIONS.completed, []);
});

test("output value bounded at MAX_OUTPUT_VALUE_LEN (tail kept)", () => {
  const big = "x".repeat(MAX_OUTPUT_VALUE_LEN + 100);
  const out = boundOutputs({ key: big });
  assert.equal(out.key.length, MAX_OUTPUT_VALUE_LEN);
  assert.ok(out.key.endsWith("x".repeat(100)));
});

test("outputs key count bounded at MAX_OUTPUTS_KEYS (oldest dropped)", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < MAX_OUTPUTS_KEYS + 20; i++) many[`k${i}`] = `v${i}`;
  const out = boundOutputs(many);
  assert.equal(Object.keys(out).length, MAX_OUTPUTS_KEYS);
  assert.ok(out.k0 === undefined); // oldest dropped
  assert.ok(out[`k${MAX_OUTPUTS_KEYS + 19}`] !== undefined);
});

test("applyTransition trims outputs through bounds", () => {
  let r = applyTransition(run(), "start");
  r = applyTransition(r, "phase_complete", {
    outputs: { a: "x".repeat(MAX_OUTPUT_VALUE_LEN + 5) },
  });
  assert.equal(r.outputs.a.length, MAX_OUTPUT_VALUE_LEN);
});

test("RunStore roundtrip + disk persist/history", () => {
  const store = new RunStore();
  const r1 = run();
  store.add(r1);
  assert.equal(store.get(r1.runId), r1);
  store.update(r1.runId, { status: "running" });
  assert.equal(store.get(r1.runId)?.status, "running");
  const done = applyTransition(store.get(r1.runId)!, "complete");
  store.update(r1.runId, done);
  store.persist(store.get(r1.runId)!);
  assert.equal(store.list().length, 1);
  store.remove(r1.runId);
  assert.equal(store.list().length, 0);

  const fresh = new RunStore();
  const history = fresh.loadHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].workflowName, "wf");
  fresh.clear();
  assert.equal(fresh.list().length, 0);
});

test("history eviction at limit keeps newest", () => {
  const store = new RunStore();
  let last: string | undefined;
  for (let i = 0; i < 105; i++) {
    const r = run();
    const done = applyTransition(r, "start");
    const finished = applyTransition(done, "complete", { endedAt: 1_700_000_000_000 + i });
    (finished as { startedAt: number }).startedAt = 1_700_000_000_000 + i;
    store.add(finished);
    store.persist(finished);
    last = finished.runId;
  }
  const history = new RunStore().loadHistory();
  assert.ok(history.length <= 100);
  assert.ok(history.some((h) => h.runId === last));
});

test("createRun generates uuid runIds and pending status", () => {
  const a = createRun("wf", makeIr(), {});
  const b = createRun("wf", makeIr(), {});
  assert.notEqual(a.runId, b.runId);
  assert.match(a.runId, /^[0-9a-f-]{36}$/);
  assert.equal(a.status, "pending");
});