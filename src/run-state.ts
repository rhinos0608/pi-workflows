/**
 * Run state: WorkflowRun struct, state machine transitions, in-memory
 * RunStore, and disk history. No execution logic — pure state tracking.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_RUN_HISTORY_DISK, WORKFLOW_RUNS_DIR } from "./constants.ts";
import type { WorkflowIR } from "./ir.ts";

export const MAX_OUTPUTS_KEYS = 100;
export const MAX_OUTPUT_VALUE_LEN = 8000;

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "stopped";

export interface SubagentRunRecord {
  runId: string;
  phaseIndex: number;
  stepIndex: number;
}

export interface WorkflowRun {
  runId: string; // uuid v4
  workflowName: string;
  irSnapshot: WorkflowIR; // IR at time of run start
  args: Record<string, unknown>;
  status: RunStatus;
  startedAt: number; // epoch ms
  updatedAt: number;
  phaseIndex: number; // current phase (0-based)
  subagentRunIds: string[]; // pi-subagents runIds (legacy-compatible)
  subagentRuns: SubagentRunRecord[]; // ownership and drilldown metadata
  outputs: Record<string, string>; // outputKey → result text (bounded)
  error?: string;
  endedAt?: number;
  elapsedMs?: number;
  tokenTotal?: number; // from pi-subagents status if available
  totalCost?: number; // from pi-subagents status if available
}

export type RunTransition =
  | "start" | "phase_complete" | "phase_failed" | "pause" | "resume" | "stop" | "complete" | "fail";

export const ALLOWED_TRANSITIONS: Record<RunStatus, RunTransition[]> = {
  pending: ["start"],
  running: ["phase_complete", "phase_failed", "pause", "stop", "complete", "fail"],
  paused: ["resume", "stop"],
  completed: [],
  failed: [],
  stopped: [],
};

export function createRun(name: string, ir: WorkflowIR, args: Record<string, unknown>): WorkflowRun {
  const now = Date.now();
  return {
    runId: randomUUID(),
    workflowName: name,
    irSnapshot: ir,
    args,
    status: "pending",
    startedAt: now,
    updatedAt: now,
    phaseIndex: 0,
    subagentRunIds: [],
    subagentRuns: [],
    outputs: {},
  };
}

/** Truncate a single output value to MAX_OUTPUT_VALUE_LEN (keeps the tail). */
export function boundOutputValue(value: string): string {
  if (value.length <= MAX_OUTPUT_VALUE_LEN) return value;
  return value.slice(value.length - MAX_OUTPUT_VALUE_LEN);
}

/** Cap outputs object: value-length bound per key; drop oldest keys past MAX_OUTPUTS_KEYS. */
export function boundOutputs(outputs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) {
    out[k] = boundOutputValue(v);
  }
  const keys = Object.keys(out);
  if (keys.length > MAX_OUTPUTS_KEYS) {
    const keep = keys.slice(keys.length - MAX_OUTPUTS_KEYS);
    for (const k of keys) {
      if (!keep.includes(k)) delete out[k];
    }
  }
  return out;
}

/**
 * Apply a state-machine transition. Returns the next run state (immutable).
 * Throws on invalid transitions.
 */
export function applyTransition(
  run: WorkflowRun,
  t: RunTransition,
  patch?: Partial<WorkflowRun>
): WorkflowRun {
  if (!ALLOWED_TRANSITIONS[run.status].includes(t)) {
    throw new Error(`invalid transition "${t}" from status "${run.status}"`);
  }
  const now = Date.now();
  const next: WorkflowRun = {
    ...run,
    ...patch,
    updatedAt: now,
  };
  if (next.outputs) next.outputs = boundOutputs(next.outputs);
  const statusByTransition: Partial<Record<RunTransition, RunStatus>> = {
    start: "running",
    phase_complete: "running",
    phase_failed: "failed",
    pause: "paused",
    resume: "running",
    stop: "stopped",
    complete: "completed",
    fail: "failed",
  };
  next.status = statusByTransition[t] ?? next.status;
  if (next.status === "completed" || next.status === "failed" || next.status === "stopped") {
    next.endedAt = next.endedAt ?? now;
    next.elapsedMs = next.elapsedMs ?? now - next.startedAt;
  }
  return next;
}

const runFile = (runId: string) => path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);

export class RunStore {
  private readonly runs = new Map<string, WorkflowRun>();

  add(run: WorkflowRun): void {
    this.runs.set(run.runId, run);
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  list(): WorkflowRun[] {
    return [...this.runs.values()];
  }

  update(runId: string, patch: Partial<WorkflowRun>): WorkflowRun | undefined {
    const current = this.runs.get(runId);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    if (next.outputs) next.outputs = boundOutputs(next.outputs);
    this.runs.set(runId, next);
    return next;
  }

  remove(runId: string): void {
    this.runs.delete(runId);
  }

  clear(): void {
    this.runs.clear();
  }

  /** Persist a run to disk; evict oldest beyond MAX_RUN_HISTORY_DISK. */
  persist(run: WorkflowRun): void {
    fs.mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
    const tmp = `${runFile(run.runId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(run, null, 2), "utf8");
    fs.renameSync(tmp, runFile(run.runId));
    this.evict();
  }

  /** Load completed runs from disk, most recently ended first. */
  loadHistory(): WorkflowRun[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const runs: WorkflowRun[] = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(WORKFLOW_RUNS_DIR, f), "utf8")) as WorkflowRun;
        if (typeof parsed?.runId === "string" && typeof parsed?.irSnapshot === "object") {
          runs.push(parsed);
        }
      } catch {
        // corrupt history file: skip, keep the rest
      }
    }
    runs.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    return runs.slice(0, MAX_RUN_HISTORY_DISK);
  }

  private evict(): void {
    let files: string[] = [];
    try {
      files = fs.readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    if (files.length <= MAX_RUN_HISTORY_DISK) return;
    const byMtime = files
      .map((f) => ({ f, m: fs.statSync(path.join(WORKFLOW_RUNS_DIR, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    const excess = byMtime.slice(0, files.length - MAX_RUN_HISTORY_DISK);
    for (const { f } of excess) {
      try {
        fs.unlinkSync(path.join(WORKFLOW_RUNS_DIR, f));
      } catch {
        // best-effort eviction: a lingering file is harmless
      }
    }
  }
}