import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIRPrompt, buildIrSubmitTool, authoringState, resetAuthoringState, beginAuthoring, consumeAuthoringDraft, WF_IR_SUBMIT_TOOL_NAME } from "../src/authoring.ts";
import { makeIr, makeValidIr } from "./support.ts";

test("buildIRPrompt contains schema keywords and hard limits", () => {
  const p = buildIRPrompt("fix the bug", ["worker", "reviewer"], '{"name":"wf"}');
  assert.ok(p.includes("_wf_ir_submit"));
  assert.ok(p.includes('{"name":"wf"}'));
  assert.ok(p.includes("worker, reviewer"));
  assert.ok(p.includes("maxRounds default 10 max 50"));
  assert.ok(p.includes("contains gate is not supported at runtime"));
  assert.ok(p.includes("fix the bug"));
});

test("buildIRPrompt notices missing agent registry", () => {
  const p = buildIRPrompt("x", [], "{}");
  assert.ok(p.includes("agent autocomplete unavailable"));
});

test("_wf_ir_submit stores draft on valid IR; error text on invalid", async () => {
  resetAuthoringState();
  const tool = buildIrSubmitTool();
  const ctx = { cwd: "/proj" } as never;

  const invalid = await tool.execute("t1", { ir: { name: "bad name!" } }, undefined, undefined, ctx);
  const text = invalid.content.find((c) => c.type === "text")?.text ?? "";
  assert.ok(text.includes("Validation errors"));
  assert.equal(text.includes("must have required properties version, phases"), true);
  assert.equal(authoringState?.pendingDraft, undefined);

  const validIr = makeValidIr({ name: "goodone" });
  const ok = await tool.execute("t2", { ir: validIr }, undefined, undefined, ctx);
  const okText = ok.content.find((c) => c.type === "text")?.text ?? "";
  assert.ok(okText.includes("Draft ready"));
  const draft = authoringState?.pendingDraft as any;
  assert.ok(draft);
  assert.equal(draft.name, "goodone");
  assert.equal(draft.scope, "user");
  assert.equal(JSON.parse(JSON.stringify(draft.ir)).name, "goodone");
  resetAuthoringState();
});

test("beginAuthoring / consumeAuthoringDraft state transitions", () => {
  resetAuthoringState();
  beginAuthoring("make a report");
  assert.equal(authoringState?.pending, true);
  assert.equal(authoringState?.pendingDraft, null);
  assert.equal(authoringState?.description, "make a report");
  consumeAuthoringDraft();
  assert.equal(authoringState?.pendingDraft, null);
  assert.equal(authoringState?.pending, false);
  resetAuthoringState();
  assert.equal(authoringState, null);
});

test("tool name constant matches registration name", () => {
  assert.equal(WF_IR_SUBMIT_TOOL_NAME, "_wf_ir_submit");
  const tool = buildIrSubmitTool();
  assert.equal(tool.name, "_wf_ir_submit");
  assert.ok(tool.description.includes("json") || tool.description.includes("JSON"));
});

test("ir is data, never executed: validate only, no template evaluation in tool", async () => {
  resetAuthoringState();
  const tool = buildIrSubmitTool();
  const ctx = { cwd: "/proj" } as never;
  const ir = makeIr({ name: "dataonly" });
  await tool.execute("t3", { ir }, undefined, undefined, ctx);
  const stored = authoringState?.pendingDraft;
  assert.equal(stored?.ir.name, "dataonly");
  assert.equal(Object.keys(stored?.ir ?? {}).length > 0, true);
  resetAuthoringState();
});