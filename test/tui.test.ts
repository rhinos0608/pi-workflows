/**
 * TUI behavior tests. Drive the real public `handleInput`/`render` APIs and
 * assert the `done` callbacks. No pi harness, no TUI framework — the TUIs
 * are plain components.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowseTui, type BrowseResult } from "../src/tui/browse-tui.ts";
import { PreviewTui, type PreviewResult } from "../src/tui/preview-tui.ts";
import { RunStore } from "../src/run-state.ts";
import { RpcAdapter } from "../src/rpc-adapter.ts";
import { WorkflowRegistry } from "../src/registry.ts";
import {
  saveWorkflow,
  saveRegistry,
  resolveWorkflowPath,
  type WorkflowDef,
} from "../src/persistence.ts";
import { makeValidIr, createMockEventBus } from "./support.ts";
import type { WorkflowIR } from "../src/ir.ts";

const cwd = mkdtempSync(join(tmpdir(), "piwf-tui-"));

/** Type each character as separate key events (as pi delivers them). */
function typeChars(tui: { handleInput(data: string): void }, text: string): void {
  for (const ch of text) tui.handleInput(ch);
}

function offAdapter(): RpcAdapter {
  // No detect() call: state stays "undetected" → treated as RPC-off.
  return new RpcAdapter(createMockEventBus().bus);
}

/** Result box: property access escapes TS's let-narrowing across closures. */
function boxed<T>(): { box: { r: T | null }; set: (r: T) => void } {
  const box = { r: null as T | null };
  return { box, set: (r: T) => { box.r = r; } };
}

function makeBrowseTui(
  done: (r: BrowseResult) => void,
  adapter: RpcAdapter = offAdapter(),
  irOverrides: Partial<WorkflowIR> = {}
): BrowseTui {
  const def: WorkflowDef = {
    name: "demo",
    ir: makeValidIr(irOverrides),
    scope: "user",
    path: resolveWorkflowPath("demo", "user", cwd),
    savedAt: new Date().toISOString(),
  };
  saveWorkflow(def, []);
  saveRegistry([{ name: def.name, scope: def.scope, path: def.path, savedAt: def.savedAt }]);
  return new BrowseTui({
    done,
    runStore: new RunStore(),
    adapter,
    registry: new WorkflowRegistry([]),
    cwd,
  });
}

function makePreviewTui(
  done: (r: PreviewResult) => void,
  ir: WorkflowIR = makeValidIr(),
  rpcAvailable = true
): PreviewTui {
  return new PreviewTui(ir, done, { rpcAvailable });
}

test("browse: c opens inline description screen; nonempty Enter creates", (t) => {
  const results: BrowseResult[] = [];
  const tui = makeBrowseTui((r) => results.push(r));
  t.after(() => tui.dispose());
  tui.handleInput("c");
  assert.match(tui.render(80).join("\n"), /Create workflow/);
  assert.match(tui.render(80).join("\n"), /Describe what it should do/);
  typeChars(tui, "fix the cache");
  tui.handleInput("\r");
  assert.deepEqual(results, [{ action: "create", description: "fix the cache" }]);
});

test("browse: Escape cancels create overlay without exiting the TUI", (t) => {
  const results: BrowseResult[] = [];
  const tui = makeBrowseTui((r) => results.push(r));
  t.after(() => tui.dispose());
  tui.handleInput("c");
  typeChars(tui, "almost");
  tui.handleInput("\u001b"); // cancel overlay only
  assert.deepEqual(results, []);
  tui.handleInput("q"); // list still alive: quit works
  assert.deepEqual(results, [{ action: "close" }]);
});

test("browse: create validates nonempty description (validation state)", (t) => {
  const results: BrowseResult[] = [];
  const tui = makeBrowseTui((r) => results.push(r));
  t.after(() => tui.dispose());
  tui.handleInput("c");
  tui.handleInput("\r"); // empty description
  assert.match(tui.render(80).join("\n"), /must not be empty/);
  assert.deepEqual(results, []);
  typeChars(tui, "build");
  tui.handleInput("\r");
  assert.deepEqual(results, [{ action: "create", description: "build" }]);
});

test("browse: RPC-off shows Run disabled and never emits run; save still usable", (t) => {
  const results: BrowseResult[] = [];
  const tui = makeBrowseTui((r) => results.push(r), offAdapter());
  t.after(() => tui.dispose());
  const render = () => tui.render(90).join("\n");
  assert.match(render(), /pi-subagents unavailable/);
  assert.match(render(), /run controls disabled/i);
  tui.handleInput("r");
  assert.equal(results.length, 0);
  assert.match(render(), /runs are disabled/);
  // Preview honors RPC-off: Run unavailable, Save works.
  tui.handleInput("\r");
  assert.match(render(), /Run unavailable/);
  tui.handleInput("r");
  assert.equal(results.length, 0);
  tui.handleInput("s");
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "save-workflow");
});

test("preview: run dispatches the working IR", () => {
  const { box, set } = boxed<PreviewResult>();
  const t = makePreviewTui(set);
  t.handleInput("r");
  assert.ok(box.r);
  assert.equal(box.r.action, "run");
  const first = box.r.ir.phases[0] as Extract<WorkflowIR["phases"][number], { type: "sequential" }>;
  assert.equal(first.steps[0].task, "do the thing");
});

test("preview: run blocked when RPC unavailable (no fake dispatch)", () => {
  const { box, set } = boxed<PreviewResult>();
  const t = makePreviewTui(set, makeValidIr(), false);
  assert.match(t.render(80).join("\n"), /Run unavailable/);
  t.handleInput("r");
  const ran = box.r;
  assert.ok(ran === null);
  t.handleInput("s"); // save stays available off-RPC
  assert.ok(box.r);
  assert.equal(box.r.action, "save");
});

test("preview: a adds a real sequential phase (agent then task)", () => {
  const { box, set } = boxed<PreviewResult>();
  const t = makePreviewTui(set);
  t.handleInput("a");
  assert.match(t.render(90).join("\n"), /agent \(Enter/);
  typeChars(t, "solver");
  t.handleInput("\r");
  assert.match(t.render(90).join("\n"), /task/);
  typeChars(t, "find root cause");
  t.handleInput("\r");
  assert.doesNotMatch(t.render(90).join("\n"), /agent \(Enter/); // form closed
  t.handleInput("r");
  assert.ok(box.r);
  assert.equal(box.r.action, "run");
  const phases = box.r.ir.phases;
  assert.equal(phases.length, 2);
  const added = phases[1] as Extract<WorkflowIR["phases"][number], { type: "sequential" }>;
  assert.deepEqual(added.steps, [{ agent: "solver", task: "find root cause" }]);
});

test("preview: empty agent blocks the add form (no default task, no TODO)", () => {
  const { box, set } = boxed<PreviewResult>();
  const t = makePreviewTui(set);
  t.handleInput("a");
  t.handleInput("\r"); // empty agent
  assert.match(t.render(90).join("\n"), /must not be empty/);
  const blockedAdd = box.r;
  assert.ok(blockedAdd === null);
  assert.match(t.render(90).join("\n"), /agent \(Enter/); // still in add form
  t.handleInput("\u001b"); // cancel add
  t.handleInput("r"); // run unchanged valid IR
  assert.ok(box.r);
  assert.equal(box.r.action, "run");
  assert.equal(box.r.ir.phases.length, 1);
});

test("preview: J/K reorder phases; selection follows", () => {
  const { box, set } = boxed<PreviewResult>();
  const ir = makeValidIr({
    phases: [
      { type: "sequential", label: "phase-a", steps: [{ agent: "worker", task: "a" }] },
      { type: "sequential", label: "phase-b", steps: [{ agent: "worker", task: "b" }] },
    ],
  });
  const t = makePreviewTui(set, ir);
  t.handleInput("J"); // move selected (phase-a) down
  t.handleInput("r");
  assert.ok(box.r);
  assert.equal(box.r.action, "run");
  assert.equal(box.r.ir.phases[0].label, "phase-b");
  assert.equal(box.r.ir.phases[1].label, "phase-a");
});

test("preview: d confirms delete; last phase is protected", () => {
  const { box, set } = boxed<PreviewResult>();
  const ir = makeValidIr({
    phases: [
      { type: "sequential", label: "phase-a", steps: [{ agent: "worker", task: "a" }] },
      { type: "sequential", label: "phase-b", steps: [{ agent: "worker", task: "b" }] },
    ],
  });
  const t = makePreviewTui(set, ir);
  t.handleInput("d");
  assert.match(t.render(90).join("\n"), /Delete phase/);
  t.handleInput("n"); // cancel
  t.handleInput("d");
  t.handleInput("y"); // confirm
  t.handleInput("r");
  assert.ok(box.r);
  assert.equal(box.r.action, "run");
  assert.equal(box.r.ir.phases.length, 1);
  assert.equal(box.r.ir.phases[0].label, "phase-b");

  // last phase cannot be deleted
  const { box: b2, set: s2 } = boxed<PreviewResult>();
  const t2 = makePreviewTui(s2);
  t2.handleInput("d");
  assert.match(t2.render(90).join("\n"), /cannot delete the last phase/);
  const blocked = b2.r;
  assert.ok(blocked === null);
});

test("preview: e edits phase label inline (no fake agents)", () => {
  const { box, set } = boxed<PreviewResult>();
  const t = makePreviewTui(set);
  t.handleInput("e");
  assert.match(t.render(90).join("\n"), /label/); // pick list shows label target
  t.handleInput("\r"); // select label
  typeChars(t, "Building");
  t.handleInput("\r"); // commit
  t.handleInput("s");
  assert.ok(box.r);
  assert.equal(box.r.action, "save");
  assert.equal(box.r.ir.phases[0].label, "Building");
});

test("preview: e edits each actual step's agent and task", () => {
  const { box, set } = boxed<PreviewResult>();
  const t = makePreviewTui(set);
  t.handleInput("e");
  t.handleInput("j"); // step 1 agent
  t.handleInput("\r");
  for (let i = 0; i < "worker".length; i++) t.handleInput("\u007f"); // clear
  typeChars(t, "solver");
  t.handleInput("\r"); // commit agent
  t.handleInput("e");
  typeChars(t, "jj"); // step 1 task
  t.handleInput("\r");
  for (let i = 0; i < "do the thing".length; i++) t.handleInput("\u007f");
  typeChars(t, "isolate the bug");
  t.handleInput("\r");
  t.handleInput("s");
  assert.ok(box.r);
  assert.equal(box.r.action, "save");
  const phase = box.r.ir.phases[0] as Extract<WorkflowIR["phases"][number], { type: "sequential" }>;
  assert.equal(phase.steps[0].agent, "solver");
  assert.equal(phase.steps[0].task, "isolate the bug");
});

test("preview: invalid edit never persists or spawns", () => {
  const { box, set } = boxed<PreviewResult>();
  const t = makePreviewTui(set);
  t.handleInput("e");
  t.handleInput("j"); // step agent
  t.handleInput("\r");
  for (let i = 0; i < "worker".length; i++) t.handleInput("\u007f"); // clear → empty
  t.handleInput("\r"); // commit empty agent: rejected
  assert.match(t.render(90).join("\n"), /must not be empty/);
  const rejected = box.r;
  assert.ok(rejected === null);
  t.handleInput("\u001b"); // abort edit
  t.handleInput("s"); // save keeps the last valid IR
  assert.ok(box.r);
  assert.equal(box.r.action, "save");
  const kept = box.r.ir.phases[0] as Extract<WorkflowIR["phases"][number], { type: "sequential" }>;
  assert.equal(kept.steps[0].agent, "worker");
});

test("preview: gate details read-only, stated in the UI", () => {
  const { box, set } = boxed<PreviewResult>();
  const ir = makeValidIr({
    phases: [
      { type: "sequential", steps: [{ agent: "worker", task: "a", outputKey: "out" }] },
      { type: "gate", condition: { type: "success", outputKey: "out" }, skipToPhase: 0 },
    ],
  });
  const t = makePreviewTui(set, ir);
  assert.match(t.render(90).join("\n"), /gate conditions are read-only/);
  t.handleInput("j"); // select gate
  t.handleInput("e"); // gate: label editable, condition not
  assert.match(t.render(90).join("\n"), /read-only/);
  t.handleInput("\r"); // edit label
  typeChars(t, "sign-off");
  t.handleInput("\r");
  t.handleInput("s");
  assert.ok(box.r);
  assert.equal(box.r.action, "save");
  const gate = box.r.ir.phases[1] as Extract<WorkflowIR["phases"][number], { type: "gate" }>;
  assert.deepEqual(gate.condition, { type: "success", outputKey: "out" }); // untouched
  assert.equal(gate.label, "sign-off");
});

test("saved preview: edited IR forwarded through save-workflow result", (t) => {
  const results: BrowseResult[] = [];
  const tui = makeBrowseTui((r) => {
    results.push(r);
    if (r.action === "save-workflow") saveWorkflow(r.def, []);
  });
  t.after(() => tui.dispose());  // Save flow: edit label, then save.
  tui.handleInput("\r"); // open preview of saved demo
  tui.handleInput("e");
  tui.handleInput("\r"); // label target
  typeChars(tui, "edited");
  tui.handleInput("\r"); // commit
  tui.handleInput("s");
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "save-workflow");
  if (results[0].action === "save-workflow") {
    assert.equal(results[0].def.name, "demo");
    assert.equal(results[0].def.ir.phases[0].label, "edited"); // edited, not original
  }
});