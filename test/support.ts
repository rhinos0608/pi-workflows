/**
 * Shared test doubles for pi-workflows. Standalone — no imports from any pi
 * repository; type-shapes only. Never shipped to Pi (test/ is excluded from
 * the extension manifest).
 */
import type { EventBus } from "../src/rpc-adapter.ts";
import type { WorkflowIR } from "../src/ir.ts";

/** Mock pi.events with recorded emits and a synchronous trigger helper. */
export function createMockEventBus(): {
  bus: EventBus;
  emitted: Array<{ channel: string; data: unknown }>;
  trigger: (channel: string, data: unknown) => void;
  listeners: Map<string, Set<(data: unknown) => void>>;
} {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const handlerFor = (channel: string): Set<(data: unknown) => void> => {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    return set;
  };
  return {
    bus: {
      on(channel: string, handler: (data: unknown) => void): () => void {
        handlerFor(channel).add(handler);
        return () => {
          handlerFor(channel).delete(handler);
        };
      },
      emit(channel: string, data: unknown): void {
        emitted.push({ channel, data });
        for (const h of [...(listeners.get(channel) ?? [])]) h(data);
      },
    },
    emitted,
    trigger: (channel: string, data: unknown) => {
      for (const h of [...(listeners.get(channel) ?? [])]) h(data);
    },
    listeners,
  };
}

/** Builds a valid minimal IR fixture. */
export function makeIr(overrides: Partial<WorkflowIR> = {}): WorkflowIR {
  return {
    name: "demo",
    version: 1,
    description: "demo workflow",
    phases: [
      { type: "sequential", steps: [{ agent: "worker", task: "do the thing" }] },
    ],
    ...overrides,
  };
}

export function makeValidIr(overrides: Partial<WorkflowIR> = {}): WorkflowIR {
  return makeIr(overrides);
}

/** Run a promise chain synchronously; resolves once the microtask queue drains. */
export function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Fake setTimeout-free poll waiting helper for coordinator tests. */
export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}