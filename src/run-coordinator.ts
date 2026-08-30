/**
 * RunCoordinator: phase sequencing over pi-subagents RPC v1 only.
 *
 * Owns "what to run next" (phase advancement, loop counters, gate evaluation,
 * polling). Never implements dispatch, lifecycle, retry, worktrees, or model
 * selection — execution delegates to adapter.spawn()/result()/stop().
 *
 * Output source: RPC `result` returns bounded terminal text. Raw text stays
 * private to run history; user notifications contain output metadata only.
 * No retry: any RPC error or subagent failure transitions to `failed`.
 *
 * Workflow/model/subagent outputs are data, never executable instructions.
 */
import { effectiveMaxAgents, type WorkflowIR, type Phase, type Step } from "./ir.ts";
import type { RpcAdapter, RpcResult } from "./rpc-adapter.ts";
import { type RunStore, type WorkflowRun, applyTransition } from "./run-state.ts";

export interface CoordinatorOptions {
  adapter: RpcAdapter;
  runStore: RunStore;
  sendUserMessage: (text: string) => void; // pi.sendUserMessage bound reference
  /** cwd passed to every RPC spawn. */
  cwd: string;
  pollIntervalMs?: number; // default 2000
}

export interface CoordinatorResult {
  runId: string;
  status: "completed" | "failed" | "stopped";
  phaseIndex: number;
  outputs: Record<string, string>;
  error?: string;
  totalTokens?: number;
  totalCost?: number;
}

export interface RunResultMessage {
  type: "pi-workflows:run-result";
  runId: string;
  workflow: string;
  status: "completed" | "failed" | "stopped";
  phases: number;
  outputKeys: string[];
  totalTokens: number | null;
  totalCost: number | null;
  error: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `{{key}}` → args[key]; simple string replacement, never evaluation. */
export function renderTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key: string) => {
    const v = args[key];
    return v === undefined || v === null ? m : String(v);
  });
}

function summaryOf(result: Extract<RpcResult, { ready: true }>): string { return result.output; }

export class RunCoordinator {
  private readonly adapter: RpcAdapter;
  private readonly runStore: RunStore;
  private readonly sendUserMessage: (text: string) => void;
  private readonly cwd: string;
  private readonly pollIntervalMs: number;
  private readonly activeSubagents = new Set<string>();
  private readonly terminalOutputs = new Map<string, string>();
  private readonly outputTruncated = new Map<string, boolean>();

  constructor(options: CoordinatorOptions) {
    this.adapter = options.adapter;
    this.runStore = options.runStore;
    this.sendUserMessage = options.sendUserMessage;
    this.cwd = options.cwd;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
  }

  /** Runs workflow to completion (or failure). Emits a structured result via sendUserMessage. */
  async run(run: WorkflowRun): Promise<CoordinatorResult> {
    if (this.adapter.state !== "available") {
      return this.emit(this.fail(run, "pi-subagents RPC v1 unavailable; runs are disabled"));
    }
    try {
      this.commit(run, applyTransition(run, "start"));
      const result = await this.executePhases(this.fresh(run));
      return this.emit(result);
    } catch (err) {
      const failed = this.fail(run, String(err));
      return this.emit(failed);
    }
  }

  /** Stop a running workflow (delegates to RPC stop; guard: running state only). */
  async stop(runId: string): Promise<void> {
    const run = this.freshById(runId);
    if (run.status !== "running") {
      throw new Error(`invalid_state: run ${runId} is not running`);
    }
    const owned = new Set(run.subagentRuns?.map((r) => r.runId) ?? run.subagentRunIds);
    for (const subagentRunId of [...this.activeSubagents].filter((id) => owned.has(id))) {
      await this.adapter.stop({ runId: subagentRunId });
    }
    this.commit(run, applyTransition(run, "stop"));
  }

  /** Stop active subagents during session shutdown. */
  async shutdown(): Promise<void> {
    for (const subagentRunId of [...this.activeSubagents]) {
      try { await this.adapter.stop({ runId: subagentRunId }); } catch { /* best effort */ }
      this.activeSubagents.delete(subagentRunId);
    }
  }

  /** RPC v1 exposes no resume; pause is intentionally unavailable. */
  async pause(_runId: string): Promise<void> {
    throw new Error("pause_unavailable: pi-subagents RPC v1 has no resume method");
  }

  // --- internals ---

  /** Fresh copy of a run from the store (single source of truth). */
  private fresh(run: WorkflowRun): WorkflowRun {
    const stored = this.runStore.get(run.runId);
    if (!stored) throw new Error(`run ${run.runId} not in store`);
    return { ...stored };
  }

  private freshById(runId: string): WorkflowRun {
    const stored = this.runStore.get(runId);
    if (!stored) throw new Error(`unknown run ${runId}`);
    return { ...stored };
  }

  /** Write through: store a next-state (copy) and return it for chaining. */
  private commit(_prev: WorkflowRun, next: WorkflowRun): WorkflowRun {
    this.runStore.update(next.runId, { ...next, updatedAt: Date.now() });
    return { ...next };
  }

  private async executePhases(run: WorkflowRun): Promise<CoordinatorResult> {
    const ir: WorkflowIR = run.irSnapshot;
    const maxAgents = effectiveMaxAgents(ir);
    let spawnCount = 0;

    let phaseIndex = run.phaseIndex;
    while (phaseIndex < ir.phases.length) {
      const phase = ir.phases[phaseIndex];
      const cur = this.freshById(run.runId);
      if (cur.status === "failed" || cur.status === "stopped") break;

      switch (phase.type) {
        case "sequential":
          const next = await this.runSequential(this.fresh(run), phase, phaseIndex, maxAgents, spawnCount);
          spawnCount = next.spawnCount;
          phaseIndex = next.phaseIndex;
          break;
        case "parallel": {
          const next = await this.runParallel(this.fresh(run), phase, phaseIndex, maxAgents, spawnCount);
          spawnCount = next.spawnCount;
          phaseIndex = next.phaseIndex;
          break;
        }
        case "gate":
          phaseIndex = this.evalGate(this.fresh(run), phase, phaseIndex);
          break;
        case "loop": {
          const next = await this.runLoop(this.fresh(run), phase, phaseIndex, maxAgents, spawnCount);
          spawnCount = next.spawnCount;
          phaseIndex = next.phaseIndex;
          break;
        }
      }
      const after = this.freshById(run.runId);
      if (after.status === "failed" || after.status === "stopped" || after.status === "paused") {
        return this.resultFrom(after);
      }
    }

    const done = applyTransition(this.freshById(run.runId), "complete", {
      phaseIndex: Math.min(phaseIndex, ir.phases.length - 1),
    });
    this.commit(run, done);
    this.runStore.persist(this.freshById(run.runId));
    const sr = this.freshById(run.runId);
    return {
      runId: run.runId,
      status: "completed",
      phaseIndex: sr.phaseIndex,
      outputs: sr.outputs,
      totalTokens: sr.tokenTotal,
      totalCost: sr.totalCost,
    };
  }

  private emit(result: CoordinatorResult): CoordinatorResult {
    if (result.status === "failed" || result.status === "stopped") {
      this.runStore.persist(this.freshById(result.runId));
    }
    const msg: RunResultMessage = {
      type: "pi-workflows:run-result",
      runId: result.runId,
      workflow: this.freshById(result.runId).workflowName,
      status: result.status,
      phases: result.phaseIndex + 1,
      outputKeys: Object.keys(result.outputs),
      totalTokens: result.totalTokens ?? null,
      totalCost: result.totalCost ?? null,
      error: result.error ?? null,
    };
    this.sendUserMessage(JSON.stringify(msg)); // void; triggers agent turn → agent_end → queue advance
    return result;
  }

  private fail(run: WorkflowRun, message: string): CoordinatorResult {
    let failed: WorkflowRun;
    const cur = this.runStore.get(run.runId) ?? run;
    try {
      failed = applyTransition(cur, "fail", { error: message });
    } catch {
      // already terminal: keep state, attach error for the report
      failed = { ...cur, error: message };
    }
    this.commit(run, failed);
    return this.resultFrom(this.freshById(run.runId));
  }

  private resultFrom(run: WorkflowRun): CoordinatorResult {
    return {
      runId: run.runId,
      status: run.status === "completed" ? "completed" : run.status === "stopped" ? "stopped" : "failed",
      phaseIndex: run.phaseIndex,
      outputs: run.outputs,
      error: run.error,
      totalTokens: run.tokenTotal,
      totalCost: run.totalCost,
    };
  }

  private async runSequential(
    run: WorkflowRun,
    phase: Extract<Phase, { type: "sequential" }>,
    phaseIndex: number,
    maxAgents: number,
    spawnCount: number
  ): Promise<{ phaseIndex: number; spawnCount: number }> {
    let count = spawnCount;
    for (const step of phase.steps) {
      if (count + 1 > maxAgents) {
        this.fail(run, "maxAgents limit reached");
        return { phaseIndex, spawnCount: count };
      }
      count += 1;
      const r = await this.spawnAndPoll(this.fresh(run), step, phaseIndex, phase.steps.indexOf(step));
      if (r.state !== "complete") {
        if (r.state === "stopped") this.commit(run, applyTransition(this.freshById(run.runId), "stop"));
        else this.fail(run, `subagent ${step.agent} ended ${r.state}`);
        return { phaseIndex, spawnCount: count };
      }
      this.recordOutput(this.fresh(run), step, r);
      const cur = this.freshById(run.runId);
      if (cur.status === "failed" || cur.status === "stopped") return { phaseIndex, spawnCount: count };
    }
    return { phaseIndex: this.advance(run, phaseIndex), spawnCount: count };
  }

  private async runParallel(
    run: WorkflowRun,
    phase: Extract<Phase, { type: "parallel" }>,
    phaseIndex: number,
    maxAgents: number,
    spawnCount: number
  ): Promise<{ phaseIndex: number; spawnCount: number }> {
    let count = spawnCount;
    const concurrency = Math.max(1, Math.min(phase.maxConcurrency ?? phase.steps.length, phase.steps.length));
    for (let i = 0; i < phase.steps.length; i += concurrency) {
      const chunk = phase.steps.slice(i, i + concurrency);
      if (count + chunk.length > maxAgents) {
        this.fail(run, "maxAgents limit reached");
        return { phaseIndex, spawnCount: count };
      }
      // Spawn the chunk concurrently, then poll all to terminal.
      const results = await Promise.all(chunk.map((step, j) => this.spawnAndPoll(this.fresh(run), step, phaseIndex, i + j)));
      count += chunk.length;
      for (const [j, step] of chunk.entries()) {
        const r = results[j];
        if (r.state !== "complete") {
          if (r.state === "stopped") this.commit(run, applyTransition(this.freshById(run.runId), "stop"));
          else this.fail(run, `subagent ${step.agent} ended ${r.state}`);
          return { phaseIndex, spawnCount: count };
        }
        this.recordOutput(this.fresh(run), step, r);
        const cur = this.freshById(run.runId);
        if (cur.status === "failed" || cur.status === "stopped") return { phaseIndex, spawnCount: count };
      }
    }
    return { phaseIndex: this.advance(run, phaseIndex), spawnCount: count };
  }

  private async runLoop(
    run: WorkflowRun,
    phase: Extract<Phase, { type: "loop" }>,
    phaseIndex: number,
    maxAgents: number,
    spawnCount: number
  ): Promise<{ phaseIndex: number; spawnCount: number }> {
    let rounds = 0;
    let count = spawnCount;
    while (true) {
      if (rounds >= phase.maxRounds) {
        this.fail(run, "loop maxRounds exceeded");
        return { phaseIndex, spawnCount: count };
      }
      for (const step of phase.steps) {
        if (count + 1 > maxAgents) {
          this.fail(run, "maxAgents limit reached");
          return { phaseIndex, spawnCount: count };
        }
        count += 1;
        const r = await this.spawnAndPoll(this.fresh(run), step, phaseIndex, phase.steps.indexOf(step));
        if (r.state !== "complete") {
          if (r.state === "stopped") this.commit(run, applyTransition(this.freshById(run.runId), "stop"));
          else this.fail(run, `subagent ${step.agent} ended ${r.state}`);
          return { phaseIndex, spawnCount: count };
        }
        this.recordOutput(this.fresh(run), step, r);
        const cur = this.freshById(run.runId);
        if (cur.status === "failed" || cur.status === "stopped") return { phaseIndex, spawnCount: count };
      }
      if (phase.until.type === "contains") {
        const output = this.terminalOutputs.get(`${run.runId}:${phase.until.outputKey}`);
        const truncated = this.outputTruncated.get(`${run.runId}:${phase.until.outputKey}`) === true;
        if (output !== undefined && output.includes(phase.until.pattern)) return { phaseIndex: this.advance(run, phaseIndex), spawnCount: count };
        if (!truncated) { rounds++; continue; }
        this.fail(run, "contains_indeterminate: result output was truncated or literal was absent");
        return { phaseIndex, spawnCount: count };
      }
      if (Object.keys(this.freshById(run.runId).outputs).length > 0) {
        return { phaseIndex: this.advance(run, phaseIndex), spawnCount: count };
      }
      rounds++;
    }
  }

  private evalGate(run: WorkflowRun, phase: Extract<Phase, { type: "gate" }>, phaseIndex: number): number {
    const cond = phase.condition;
    if (cond.type === "contains") {
      const output = this.terminalOutputs.get(`${run.runId}:${cond.outputKey}`);
      const truncated = this.outputTruncated.get(`${run.runId}:${cond.outputKey}`) === true;
      if (output !== undefined && output.includes(cond.pattern)) return phaseIndex + 1;
      if (!truncated) return phase.skipToPhase;
      this.fail(run, "contains_indeterminate: result output was truncated or literal was absent");
      return phaseIndex;
    }
    const passes = Object.prototype.hasOwnProperty.call(this.freshById(run.runId).outputs, cond.outputKey);
    if (passes) {
      return phaseIndex + 1;
    }
    return phase.skipToPhase;
  }

  private recordOutput(run: WorkflowRun, step: Step, r: Extract<RpcResult, { ready: true }>): void {
    const next = this.fresh(run);
    if (step.outputKey !== undefined) {
      next.outputs[step.outputKey] = summaryOf(r);
      const outputKey = `${run.runId}:${step.outputKey}`;
      this.terminalOutputs.set(outputKey, r.output);
      this.outputTruncated.set(outputKey, r.outputTruncated);
    }
    this.commit(run, next);
  }

  /** Spawn one step (async:true always) and poll until terminal. No retry. */
  private async spawnAndPoll(run: WorkflowRun, step: Step, phaseIndex: number, stepIndex: number): Promise<Extract<RpcResult, { ready: true }>> {
    const task = renderTemplate(step.task, run.args);
    const spawn = await this.adapter.spawn({
      agent: step.agent,
      task,
      context: step.context ?? "fresh",
      cwd: this.cwd,
    });
    this.activeSubagents.add(spawn.runId);
    const withRunId = this.fresh(run);
    withRunId.subagentRunIds.push(spawn.runId);
    withRunId.subagentRuns = withRunId.subagentRuns ?? [];
    withRunId.subagentRuns.push({ runId: spawn.runId, phaseIndex, stepIndex });
    this.commit(run, withRunId);
    for (;;) {
      await sleep(this.pollIntervalMs);
      const result = await this.adapter.result({ runId: spawn.runId });
      if (!result.ready) continue;
      this.activeSubagents.delete(spawn.runId);
      return result;
    }
  }

  private advance(run: WorkflowRun, phaseIndex: number): number {
    const next = phaseIndex + 1;
    this.commit(run, applyTransition(this.freshById(run.runId), "phase_complete", { phaseIndex: next }));
    return next;
  }
}