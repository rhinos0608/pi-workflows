import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowRegistry, type KnownCommand } from "../src/registry.ts";
import { makeIr } from "./support.ts";
import { resolveWorkflowPath, type WorkflowDef } from "../src/persistence.ts";

const piCommands: KnownCommand[] = [
  { name: "init", source: "extension" },
  { name: "my-skill", source: "skill" },
  { name: "my-prompt", source: "prompt" },
  { name: "other-ext-cmd", source: "extension" },
];

function defOf(name: string, scope: "user" | "project", cwd: string): WorkflowDef {
  return {
    name,
    ir: makeIr({ name }),
    scope,
    path: resolveWorkflowPath(name, scope, cwd),
    savedAt: new Date().toISOString(),
  };
}

test("reserved name collision", () => {
  const r = new WorkflowRegistry(piCommands);
  const c = r.checkCollision("init");
  assert.deepEqual(c, { collision: true, kind: "builtin", existing: "init" });
});

test("skill collision", () => {
  const r = new WorkflowRegistry(piCommands);
  const c = r.checkCollision("my-skill");
  assert.deepEqual(c, { collision: true, kind: "skill", existing: "my-skill" });
});

test("prompt collision", () => {
  const r = new WorkflowRegistry(piCommands);
  const c = r.checkCollision("my-prompt");
  assert.deepEqual(c, { collision: true, kind: "skill", existing: "my-prompt" });
});

test("extension-source commands from other extensions are NOT collisions", () => {
  const r = new WorkflowRegistry(piCommands);
  assert.deepEqual(r.checkCollision("other-ext-cmd"), { collision: false });
});

test("no collision on new name", () => {
  const r = new WorkflowRegistry(piCommands);
  assert.deepEqual(r.checkCollision("brand-new"), { collision: false });
});

test("workflow duplicate rejected after register", () => {
  const r = new WorkflowRegistry(piCommands);
  const def = defOf("w1", "user", "/tmp");
  r.register("w1", def);
  const c = r.checkCollision("w1");
  assert.deepEqual(c, { collision: true, kind: "workflow", existing: "w1" });
});

test("idempotent re-register same scope+path allowed", () => {
  const r = new WorkflowRegistry(piCommands);
  const def = defOf("w1", "user", "/tmp");
  r.register("w1", def);
  assert.deepEqual(r.checkCollision("w1", { scope: "user", path: def.path }), { collision: false });
  r.register("w1", def); // must not throw
  assert.deepEqual(r.names(), ["w1"]);
});

test("get/names after registration", () => {
  const r = new WorkflowRegistry([]);
  const def = defOf("a1", "project", "/proj");
  r.register("a1", def);
  assert.equal(r.get("a1"), def);
  assert.equal(r.get("nope"), undefined);
  assert.deepEqual(r.names(), ["a1"]);
});

test("unregister drops name", () => {
  const r = new WorkflowRegistry([]);
  r.register("x", defOf("x", "user", "/tmp"));
  r.unregister("x");
  assert.deepEqual(r.names(), []);
});