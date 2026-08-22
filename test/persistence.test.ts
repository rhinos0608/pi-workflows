import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateWorkflowName,
  resolveWorkflowPath,
  saveWorkflow,
  loadWorkflow,
  loadRegistry,
  saveRegistry,
  atomicWriteJson,
  softDeleteWorkflow,
  type WorkflowDef,
} from "../src/persistence.ts";
import { makeIr } from "./support.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "piwf-test-"));
}

function makeDef(name: string, scope: "user" | "project", cwd: string, ir = makeIr({ name })): WorkflowDef {
  return {
    name,
    description: ir.description,
    ir,
    scope,
    path: resolveWorkflowPath(name, scope, cwd),
    savedAt: new Date().toISOString(),
  };
}

test("validateWorkflowName: all 5 checks", () => {
  assert.equal(validateWorkflowName("good_name-1").ok, true);
  assert.equal(validateWorkflowName("").ok, false);
  assert.equal(validateWorkflowName("  spaced  ").ok, false);
  assert.equal(validateWorkflowName("bad name!").ok, false);
  assert.equal(validateWorkflowName("init").ok, false); // reserved
  assert.equal(validateWorkflowName("workflows").ok, false); // own command
  assert.equal(validateWorkflowName(".").ok, false);
  assert.equal(validateWorkflowName("..").ok, false);
  assert.equal(validateWorkflowName("x".repeat(129)).ok, false);
  assert.equal(validateWorkflowName("x".repeat(128)).ok, true);
});

test("resolveWorkflowPath: user vs project", () => {
  const cwd = tmpDir();
  const user = resolveWorkflowPath("n", "user", cwd);
  assert.ok(user.endsWith(path.join("pi-workflows", "saved", "n.json")));
  const proj = resolveWorkflowPath("n", "project", cwd);
  assert.equal(proj, path.join(cwd, ".pi", "workflows", "n.json"));
});

test("saveWorkflow writes atomically with .bak; loadWorkflow reads back", () => {
  const cwd = tmpDir();
  const def = makeDef("wf1", "user", cwd);
  const res = saveWorkflow(def, []);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(fs.existsSync(def.path));
  assert.ok(fs.existsSync(`${def.path}.bak`));
  const loaded = loadWorkflow("wf1", cwd);
  assert.ok(loaded);
  assert.equal(loaded?.ir.name, "wf1");
});

test("project scope wins over user scope", () => {
  const cwd = tmpDir();
  const projectDef = makeDef("dup", "project", cwd, makeIr({ name: "dup", description: "project version" }));
  const userDef = makeDef("dup", "user", cwd, makeIr({ name: "dup", description: "user version" }));
  saveWorkflow(projectDef, []);
  saveWorkflow(userDef, []);
  const loaded = loadWorkflow("dup", cwd);
  assert.equal(loaded?.description, "project version");
});

test("corrupt file recovers from .bak", () => {
  const cwd = tmpDir();
  const def = makeDef("recover", "user", cwd);
  saveWorkflow(def, []);
  fs.writeFileSync(def.path, "not json{{{", "utf8");
  const loaded = loadWorkflow("recover", cwd);
  assert.ok(loaded);
  assert.equal(loaded?.name, "recover");
});

test("registry roundtrip: save, load, soft-delete, prune on write", () => {
  const cwd = tmpDir();
  const def = makeDef("reg1", "user", cwd);
  const res = saveWorkflow(def, []);
  assert.ok(res.ok);
  if (!res.ok) return;
  saveRegistry([res.entry]);
  assert.equal(loadRegistry().length, 1);

  const entries = loadRegistry();
  assert.equal(softDeleteWorkflow("missing", entries), false);

  assert.equal(softDeleteWorkflow("reg1", entries), true);
  assert.equal(entries.some((e) => e.name === "reg1" && e.deleted), true);
  saveRegistry(entries);
  // deleted entries are pruned on write
  assert.equal(loadRegistry().length, 0);
});

test("saveWorkflow name collision (different path) rejected", () => {
  const cwd = tmpDir();
  const def = makeDef("c1", "user", cwd);
  const res1 = saveWorkflow(def, []);
  assert.ok(res1.ok);
  if (!res1.ok) return;
  const clash = makeDef("c1", "project", cwd);
  const res2 = saveWorkflow(clash, [res1.entry]);
  assert.equal(res2.ok, false);
  if (!res2.ok) assert.equal(res2.reason, "name_collision");
});

test("atomicWriteJson overwrites cleanly", () => {
  const cwd = tmpDir();
  const p = path.join(cwd, "a.json");
  atomicWriteJson(p, { v: 1 });
  atomicWriteJson(p, { v: 2 });
  const read = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(read.v, 2);
});

test("loadWorkflow ignores files with wrong name or invalid IR", () => {
  const cwd = tmpDir();
  const def = makeDef("ok", "user", cwd);
  saveWorkflow(def, []);
  fs.mkdirSync(path.dirname(resolveWorkflowPath("ok", "project", cwd)), { recursive: true });
  fs.writeFileSync(resolveWorkflowPath("ok", "project", cwd), JSON.stringify({ name: "evil", ir: { not: "ir" } }), "utf8");
  const loaded = loadWorkflow("ok", cwd);
  assert.equal(loaded?.name, "ok"); // project file with wrong name skipped; user def loaded
});