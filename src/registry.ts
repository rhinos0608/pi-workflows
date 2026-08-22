/**
 * WorkflowRegistry: collision detection against Pi built-ins, skills, and
 * prompts, plus idempotent registration records.
 *
 * Does not call pi.registerCommand itself — returns collision info and keeps
 * registered defs for the composition root, which owns registration.
 */
import { RESERVED_PI_NAMES } from "./constants.ts";
import type { WorkflowDef } from "./persistence.ts";

/** Matches pi.getCommands()[i].source exactly (top-level field). */
export type CommandSource = "extension" | "prompt" | "skill";

export interface KnownCommand {
  name: string;
  source: CommandSource;
}

export type CollisionResult =
  | { collision: false }
  | { collision: true; kind: "builtin" | "skill" | "workflow"; existing: string };

export class WorkflowRegistry {
  private readonly piCommands: KnownCommand[];
  private readonly registered = new Map<string, WorkflowDef>();

  constructor(piCommands: KnownCommand[]) {
    this.piCommands = piCommands;
  }

  /** Collision logic, in order: reserved name → skill/prompt command → registered workflow.
   * `sameDef`: when provided, re-registering the exact same scope+path is allowed
   * (idempotent re-register). */
  checkCollision(name: string, sameDef?: { scope: string; path: string }): CollisionResult {
    if (RESERVED_PI_NAMES.has(name)) {
      return { collision: true, kind: "builtin", existing: name };
    }
    const cmd = this.piCommands.find(
      (c) => c.name === name && (c.source === "skill" || c.source === "prompt")
    );
    if (cmd) {
      return { collision: true, kind: "skill", existing: name };
    }
    const existing = this.registered.get(name);
    if (existing) {
      if (sameDef && existing.scope === sameDef.scope && existing.path === sameDef.path) {
        return { collision: false };
      }
      return { collision: true, kind: "workflow", existing: name };
    }
    return { collision: false };
  }

  /** Record that this name is now registered as a workflow command. */
  register(name: string, def: WorkflowDef): void {
    this.registered.set(name, def);
  }

  get(name: string): WorkflowDef | undefined {
    return this.registered.get(name);
  }

  names(): string[] {
    return [...this.registered.keys()];
  }

  /** Drop a registration (soft-delete / reload path). */
  unregister(name: string): void {
    this.registered.delete(name);
  }
}