import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDirectives } from "../src/parser.ts";

const known = new Set(["wf-a", "skill1", "other"]);

test("pure prose passes through untouched", () => {
  const r = parseDirectives("hello world, nothing to see here", known);
  assert.equal(r.directiveCount, 0);
  assert.equal(r.tokens.length, 1);
  assert.deepEqual(r.tokens, [{ type: "prose", text: "hello world, nothing to see here" }]);
});

test("single directive with args", () => {
  const r = parseDirectives("start /wf-a foo=1 bar", known);
  assert.equal(r.directiveCount, 1);
  assert.deepEqual(r.tokens, [
    { type: "prose", text: "start " },
    { type: "directive", name: "wf-a", args: "foo=1 bar", raw: "/wf-a foo=1 bar" },
  ]);
});

test("three directives with prose in between", () => {
  const r = parseDirectives("/skill1 x /wf-a one two /other", known);
  assert.equal(r.directiveCount, 3);
  assert.equal(r.tokens.filter((t) => t.type === "directive").length, 3);
  assert.deepEqual(r.tokens[1], { type: "directive", name: "wf-a", args: "one two", raw: "/wf-a one two" });
});

test("unknown /foo preserved verbatim as prose", () => {
  const r = parseDirectives("see /foo for details", known);
  assert.equal(r.directiveCount, 0);
  assert.equal(r.tokens.length, 1);
  assert.deepEqual(r.tokens, [{ type: "prose", text: "see /foo for details" }]);
});

test("9th directive becomes prose (max 8)", () => {
  const input = Array.from({ length: 8 }, (_, i) => `/wf-a n=${i}`).join(" ") + " /skill1 x";
  const r = parseDirectives(input, known);
  assert.equal(r.directiveCount, 8);
  const prose = r.tokens.filter((t) => t.type === "prose");
  assert.ok(prose.some((t) => t.type === "prose" && t.text.includes("/skill1 x")));
});

test("empty known set = all prose", () => {
  const r = parseDirectives("/wf-a /skill1 x", new Set());
  assert.equal(r.directiveCount, 0);
  assert.equal(r.tokens.length, 1);
  assert.equal(r.tokens[0].type, "prose");
});

test("double-slash is prose", () => {
  const r = parseDirectives("//double-slash", known);
  assert.equal(r.directiveCount, 0);
  assert.deepEqual(r.tokens, [{ type: "prose", text: "//double-slash" }]);
});

test("args trimmed at edges; raw keeps full untrimmed span", () => {
  const r = parseDirectives("before /wf-a   padded", known);
  assert.equal(r.directiveCount, 1);
  const dir = r.tokens.find((t) => t.type === "directive");
  assert.equal(dir && dir.type === "directive" && dir.args, "padded");
  assert.equal(dir && dir.type === "directive" && dir.raw.includes("/wf-a   padded"), true);
});

test("injection attempt lands in args (data), never executed by parser", () => {
  const r = parseDirectives("explain /wf-a eval(malicious())", known);
  assert.equal(r.directiveCount, 1);
  const dir = r.tokens.find((t) => t.type === "directive");
  assert.equal(dir && dir.type === "directive" && dir.args, "eval(malicious())");
});

test("name chars beyond [a-zA-Z0-9_-] break directive start", () => {
  const r = parseDirectives("/wf-a!x", known);
  assert.equal(r.directiveCount, 1);
  const dir = r.tokens.find((t) => t.type === "directive");
  assert.equal(dir && dir.type === "directive" && dir.args, "!x");
});