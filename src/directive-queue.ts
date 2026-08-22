/**
 * DirectiveQueue: session-scoped sequencing of mixed directive input.
 *
 * `input` fires before skill expansion, so `/wf-name /skill-foo some prose`
 * must be queued and processed one item per agent turn. Advancement happens
 * ONLY on agent_end / agent_settled — never on sendUserMessage return.
 *
 * Injection guard: directive args are data. `processNext` never evaluates
 * args; workflow handlers receive them as strings for `{{arg}}` substitution.
 * Extension-originated input is skipped upstream (event.source === "extension"),
 * so re-injected skill messages cannot recurse.
 */
import type { InputToken } from "./parser.ts";

export type QueueItem =
  | { type: "prose"; text: string }
  | { type: "workflow"; name: string; args: string }
  | { type: "skill"; name: string; args: string };

/** Registered workflow handler map, populated at session_start registration time. */
export type WorkflowHandlerMap = Map<string, (args: string) => Promise<void>>;

export class DirectiveQueue {
  private items: QueueItem[] = [];
  private active = false;
  private completionSeen = false;
  private handlerMap: WorkflowHandlerMap = new Map();

  /** Set at session_start, cleared on session_start reset. */
  setHandlerMap(map: WorkflowHandlerMap): void {
    this.handlerMap = map;
  }

  /** Clear queue and reset active flag (call on session_start). */
  clear(): void {
    this.items = [];
    this.active = false;
    this.completionSeen = false;
  }

  get pending(): boolean {
    return this.items.length > 0 || this.active;
  }

  /**
   * Build the queue from parsed tokens. Silently ignores a new enqueue while
   * the queue is in flight (no recursion).
   */
  enqueue(
    tokens: InputToken[],
    workflowNames: ReadonlySet<string>,
    skillNames: ReadonlySet<string>
  ): void {
    if (this.items.length > 0) return;
    for (const token of tokens) {
      if (token.type === "prose") {
        const text = token.text.trim();
        if (text) this.items.push({ type: "prose", text });
        continue;
      }
      if (workflowNames.has(token.name)) {
        this.items.push({ type: "workflow", name: token.name, args: token.args });
      } else if (skillNames.has(token.name)) {
        this.items.push({ type: "skill", name: token.name, args: token.args });
      } else {
        // Unknown directive name (defensive): preserve as prose.
        const text = token.raw.trim();
        if (text) this.items.push({ type: "prose", text });
      }
    }
  }

  /**
   * Process the next item. Call once immediately after enqueue, then again on
   * each agent_end / agent_settled. Never advances on sendUserMessage return.
   */
  processNext(sendUserMessage: (text: string) => void): void {
    if (this.active || this.items.length === 0) return;
    const item = this.items.shift()!;
    this.active = true;
    this.completionSeen = false;
    try {
      if (item.type === "prose") {
        sendUserMessage(item.text); // void; agent_end fires when Pi processes this
      } else if (item.type === "skill") {
        // Reinject as canonical form so Pi performs native skill expansion in its own turn.
        const canonical = item.args ? `/${item.name} ${item.args}` : `/${item.name}`;
        sendUserMessage(canonical); // void; agent_end fires after expansion
      } else {
        // Call registered handler directly — do NOT reinject via sendUserMessage:
        // extension-source reinjection bypasses command routing.
        const handler = this.handlerMap.get(item.name);
        if (handler) {
          // The handler runs the coordinator, which calls sendUserMessage when
          // done, triggering an agent turn → agent_end → processNext again.
          // Not awaited here to avoid blocking the event loop.
          void handler(item.args).catch((err: unknown) => {
            sendUserMessage(`[pi-workflows] workflow error: ${String(err)}`);
          });
        } else {
          sendUserMessage(`[pi-workflows] no handler for /${item.name}; run /reload to restore`);
        }
      }
    } finally {
      if (item.type !== "workflow") this.completionSeen = false;
    }
  }

  completeTurn(): boolean {
    if (!this.active || this.completionSeen) return false;
    this.completionSeen = true;
    this.active = false;
    return true;
  }
}