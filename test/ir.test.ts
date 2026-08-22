import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, WorkflowIRSchema } from "../src/ir.ts";
import { MAX_ROUNDS_CEILING, MAX_AGENTS_CEILING } from "../src/constants.ts";
import { makeIr } from "./support.ts";

test("valid IR with all four phase types passes", () => {
  const ir = makeIr({
    phases: [
      { type: "sequential", label: "s1", steps: [{ agent: "a", task: "t1" }] },
      {
        type: "parallel",
        label: "p1",
        maxConcurrency: 2,
        steps: [
          { agent: "a", task: "t2", outputKey: "out2" },
          { agent: "b", task: "t3", outputKey: "out3" },
        ],
      },
      { type: "gate", label: "g1", condition: { type: "success", outputKey: "out2" }, skipToPhase: 0 },
      { type: "loop", label: "l1", until: { type: "success" }, maxRounds: 3, steps: [{ agent: "a", task: "t4" }] },
    ],
    args: { topic: { type: "string", required: true, description: "subject" } },
    limits: { maxRounds: 5, maxAgents: 4 },
  });
  const res = validate(ir);
  assert.equal(res.ok, true);
});

test("missing/unknown version is rejected", () => {
  const bad = { ...makeIr(), version: 2 };
  const res = validate(bad);
  assert.equal(res.ok, false);
  const missing = { ...makeIr() };
  delete (missing as Record<string, unknown>).version;
  assert.equal(validate(missing).ok, false);
});

test("bad name pattern rejected", () => {
  const bad = makeIr({ name: "has space" });
  const res = validate(bad);
  assert.equal(res.ok, false);
});

test("bad skipToPhase index rejected", () => {
  const bad = makeIr({
    phases: [
      { type: "sequential", steps: [{ agent: "a", task: "x" }] },
      { type: "gate", condition: { type: "success", outputKey: "k" }, skipToPhase: 9 },
    ],
  });
  const res = validate(bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("skipToPhase")));
});

test("self-referential gate (skipToPhase == own index) rejected", () => {
  const bad = makeIr({
    phases: [
      { type: "gate", condition: { type: "success", outputKey: "k" }, skipToPhase: 0 },
      { type: "sequential", steps: [{ agent: "a", task: "x" }] },
    ],
  });
  const res = validate(bad);
  assert.equal(res.ok, false);
});

test("duplicate outputKey within one phase rejected", () => {
  const bad = makeIr({
    phases: [
      {
        type: "sequential",
        steps: [
          { agent: "a", task: "x", outputKey: "dup" },
          { agent: "b", task: "y", outputKey: "dup" },
        ],
      },
    ],
  });
  const res = validate(bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("duplicate outputKey")));
});

test("same outputKey across different phases is allowed", () => {
  const ir = makeIr({
    phases: [
      { type: "sequential", steps: [{ agent: "a", task: "x", outputKey: "k" }] },
      { type: "sequential", steps: [{ agent: "b", task: "y", outputKey: "k" }] },
    ],
  });
  const res = validate(ir);
  assert.equal(res.ok, true);
});

test("loop maxRounds above ceiling rejected", () => {
  const bad = makeIr({
    phases: [
      { type: "loop", until: { type: "success" }, maxRounds: MAX_ROUNDS_CEILING + 1, steps: [{ agent: "a", task: "x" }] },
    ],
  });
  const res = validate(bad);
  assert.equal(res.ok, false);
});

test("limits bounds enforced by schema", () => {
  const over = makeIr({ limits: { maxAgents: MAX_AGENTS_CEILING + 5 } });
  assert.equal(validate(over).ok, false);
  const ok = makeIr({ limits: { maxRounds: MAX_ROUNDS_CEILING, maxAgents: MAX_AGENTS_CEILING } });
  assert.equal(validate(ok).ok, true);
});

test("contains gate stays valid in the schema (rejected at runtime, not schema time)", () => {
  const ir = makeIr({
    phases: [
      { type: "sequential", steps: [{ agent: "a", task: "x", outputKey: "k" }] },
      { type: "gate", condition: { type: "contains", outputKey: "k", pattern: "done" }, skipToPhase: 0 },
    ],
  });
  const res = validate(ir);
  assert.equal(res.ok, true);
});

test("non-object input rejected", () => {
  assert.equal(validate(null).ok, false);
  assert.equal(validate("nope").ok, false);
  assert.equal(validate(42).ok, false);
});

test("empty phases rejected", () => {
  const bad = makeIr({ phases: [] });
  assert.equal(validate(bad).ok, false);
});

test("schema serializes to JSON (used in buildIRPrompt)", () => {
  const json = JSON.stringify(WorkflowIRSchema);
  assert.ok(json.includes('"name"'));
  assert.ok(json.includes('"minItems"'));
});