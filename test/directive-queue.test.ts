import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectiveQueue } from "../src/directive-queue.ts";
import type { InputToken } from "../src/parser.ts";

type Item = Parameters<DirectiveQueue["enqueue"]>[0][0];
type AnyHandler = (args: string) => Promise<void>;

function toTokens(items: Item[]): InputToken[] {
  return items as unknown as InputToken[];
}

test("prose token → sendUserMessage; queue drains", () => {
  const q = new DirectiveQueue();
  const sent: string[] = [];
  q.enqueue(toTokens([{ type: "prose", text: "hello" }]), new Set(), new Set());
  assert.equal(q.pending, true);
  q.processNext((t) => sent.push(t));
  assert.deepEqual(sent, ["hello"]);
  assert.equal(q.completeTurn(), true);
  assert.equal(q.pending, false);
});

test("skill token reinjected in canonical form", () => {
  const q = new DirectiveQueue();
  const sent: string[] = [];
  q.enqueue(toTokens([{ type: "directive", name: "skill-foo", args: "a b", raw: "/skill-foo a b" }]), new Set(), new Set(["skill-foo"]));
  q.processNext((t) => sent.push(t));
  assert.deepEqual(sent, ["/skill-foo a b"]);
});

test("workflow token calls registered handler directly, not via sendUserMessage", () => {
  const q = new DirectiveQueue();
  const map = new Map<string, (args: string) => Promise<void>>();
  let called = "";
  map.set("wf-one", async (args: string) => {
    called = args;
  });
  q.setHandlerMap(map as unknown as Map<string, (args: string) => Promise<void>>);
  const sent: string[] = [];
  q.enqueue(toTokens([{ type: "directive", name: "wf-one", args: "x=1", raw: "/wf-one x=1" }]), new Set(["wf-one"]), new Set());
  q.processNext((t) => sent.push(t));
  assert.equal(called, "x=1");
  assert.deepEqual(sent, []); // handler invoked directly
});

test("unknown directive name treated as prose", () => {
  const q = new DirectiveQueue();
  const sent: string[] = [];
  q.enqueue(toTokens([{ type: "directive", name: "mystery", args: "", raw: "/mystery" }]), new Set(), new Set());
  q.processNext((t) => sent.push(t));
  assert.deepEqual(sent, ["/mystery"]);
});

test("second enqueue while items pending is a silent no-op", () => {
  const q = new DirectiveQueue();
  q.enqueue(
    toTokens([
      { type: "prose", text: "first" },
      { type: "prose", text: "second" },
    ]),
    new Set(),
    new Set()
  );
  // queue still holds items → new enqueue silently dropped
  q.enqueue(toTokens([{ type: "prose", text: "third" }]), new Set(), new Set());
  const sent: string[] = [];
  q.processNext((t) => sent.push(t));
  q.completeTurn();
  q.processNext((t) => sent.push(t));
  q.completeTurn();
  assert.deepEqual(sent, ["first", "second"]);
  assert.equal(q.pending, false);
});

test("workflow handler error surfaced via sendUserMessage, queue continues", () => {
  const q = new DirectiveQueue();
  const map = new Map<string, (args: string) => Promise<void>>();
  map.set("wf-bad", async () => {
    throw new Error("boom");
  });
  q.setHandlerMap(map as unknown as Map<string, (args: string) => Promise<void>>);
  const sent: string[] = [];
  q.enqueue(toTokens([{ type: "directive", name: "wf-bad", args: "", raw: "/wf-bad" }]), new Set(["wf-bad"]), new Set());
  q.processNext((t) => sent.push(t));
  return new Promise<void>((r) => {
    setTimeout(() => {
      assert.equal(sent.length, 1);
      assert.ok(sent[0].includes("boom"));
      q.completeTurn();
      assert.equal(q.pending, false);
      r();
    }, 30);
  });
});

test("missing handler message with reload hint", () => {
  const q = new DirectiveQueue();
  q.setHandlerMap(new Map());
  const sent: string[] = [];
  q.enqueue(toTokens([{ type: "directive", name: "wf-missing", args: "", raw: "/wf-missing" }]), new Set(["wf-missing"]), new Set());
  q.processNext((t) => sent.push(t));
  assert.ok(sent[0].includes("/reload"));
});

test("clear resets queue and active flag", () => {
  const q = new DirectiveQueue();
  q.enqueue(toTokens([{ type: "prose", text: "x" }]), new Set(), new Set());
  q.clear();
  assert.equal(q.pending, false);
});

test("empty prose tokens skipped", () => {
  const q = new DirectiveQueue();
  const sent: string[] = [];
  q.enqueue(toTokens([{ type: "prose", text: "   " }]), new Set(), new Set());
  q.processNext((t) => sent.push(t));
  assert.deepEqual(sent, []);
  assert.equal(q.pending, false);
});
test("queued workflows wait for result lifecycle completion", async () => {
  const q = new DirectiveQueue();
  const calls: string[] = [];
  const map = new Map<string, (args: string) => Promise<void>>([
    ["wf-one", async () => { calls.push("one"); }],
    ["wf-two", async () => { calls.push("two"); }],
  ]);
  q.setHandlerMap(map);
  q.enqueue(toTokens([
    { type: "directive", name: "wf-one", args: "", raw: "/wf-one" },
    { type: "directive", name: "wf-two", args: "", raw: "/wf-two" },
  ]), new Set(["wf-one", "wf-two"]), new Set());
  q.processNext(() => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["one"]);
  assert.equal(q.pending, true);
  q.completeTurn();
  q.processNext(() => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["one", "two"]);
});
