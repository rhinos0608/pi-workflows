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

const reviewKnown = new Set(["review", "verify"]);

function dir(tokens: ReturnType<typeof parseDirectives>["tokens"], name: string) {
  return tokens.find(
    (t): t is Extract<ReturnType<typeof parseDirectives>["tokens"][number], { type: "directive" }> =>
      t.type === "directive" && t.name === name
  );
}

test("exact connector regression: prose kept, connector clauses never become args", () => {
  const r = parseDirectives(
    "Do X, then /review, then loop until reviewers satisfied and then /verify",
    reviewKnown
  );
  assert.equal(r.directiveCount, 2);
  assert.deepEqual(r.tokens[0], { type: "prose", text: "Do X, then " });
  const review = dir(r.tokens, "review");
  const verify = dir(r.tokens, "verify");
  assert.equal(review && review.args, "");
  assert.equal(verify && verify.args, "");
});

test("explicit inline args via colon", () => {
  const r = parseDirectives("/review: inspect cache", reviewKnown);
  const review = dir(r.tokens, "review");
  assert.equal(review && review.args, "inspect cache");
  assert.equal(r.directiveCount, 1);
});

test("explicit inline args via 'to'", () => {
  const r = parseDirectives("/review to inspect cache", reviewKnown);
  const review = dir(r.tokens, "review");
  assert.equal(review && review.args, "inspect cache");
});

test("each connector never becomes preceding args", () => {
  for (const conn of ["then", "and then", "afterwards", "followed by"]) {
    const r = parseDirectives(`/wf-a first, ${conn} /skill1`, known);
    const wf = dir(r.tokens, "wf-a");
    assert.equal(wf && wf.args, "first", `connector "${conn}"`);
  }
});

test("connector-only tail yields empty args", () => {
  for (const conn of ["then", "and then", "afterwards", "followed by"]) {
    const r = parseDirectives(`Do X, ${conn} /review, ${conn} /verify`, reviewKnown);
    const review = dir(r.tokens, "review");
    const verify = dir(r.tokens, "verify");
    assert.equal(review && review.args, "", `connector "${conn}"`);
    assert.equal(verify && verify.args, "", `connector "${conn}"`);
  }
});

test("explicit args ending in connector omit the trailing connector", () => {
  const r = parseDirectives(
    "/wf-a inspect cache, then /skill1 afterwards /other",
    known
  );
  const wf = dir(r.tokens, "wf-a");
  assert.equal(wf && wf.args, "inspect cache");
  const skill = dir(r.tokens, "skill1");
  assert.equal(skill && skill.args, "");
});

test("connector before cap-exceeded directive is not a dispatch separator", () => {
  const input =
    Array.from({ length: 8 }, (_, i) => `/wf-a n=${i}`).join(" ") +
    ", then /skill1 x";
  const r = parseDirectives(input, known);
  assert.equal(r.directiveCount, 8);
  const dirs = r.tokens.filter((t) => t.type === "directive");
  assert.equal(dirs.length, 8);
  assert.equal(dirs[7].args, "n=7"); // connector stripped, ordinary args kept
  const prose = r.tokens.filter((t) => t.type === "prose");
  assert.equal(prose.length, 1);
  assert.equal(prose[0].text, "/skill1 x"); // 9th stays prose: cap semantics kept
});

test("ordinary positional args preserved when not connector-delimited", () => {
  const r = parseDirectives("/wf-a one two three", known);
  const wf = dir(r.tokens, "wf-a");
  assert.equal(wf && wf.args, "one two three");
});