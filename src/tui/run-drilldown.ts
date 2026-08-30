/**
 * RunDrilldown: readonly phase → agent detail for a WorkflowRun.
 * Data from RunStore + RPC result only; never reads pi-subagents artifacts.
 * RPC-gap states render truthfully as "[data unavailable]".
 */
import type { RpcAdapter, RpcResult } from "../rpc-adapter.ts";
import type { WorkflowRun } from "../run-state.ts";
import { BAR, COPY, KEY } from "./text.ts";

export class RunDrilldown {
  private readonly run: WorkflowRun;
  private readonly adapter: RpcAdapter;
  private readonly onBack: () => void;
  private readonly onInvalidate: () => void;
  private results = new Map<string, RpcResult | "error" | "unavailable">();
  private selectedPhase = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(run: WorkflowRun, adapter: RpcAdapter, onBack: () => void, onInvalidate: () => void = () => {}) {
    this.run = run;
    this.adapter = adapter;
    this.onBack = onBack;
    this.onInvalidate = onInvalidate;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 2000);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const records = this.run.subagentRuns?.length
      ? this.run.subagentRuns.filter((r) => r.phaseIndex === this.selectedPhase)
      : this.run.subagentRunIds.map((runId, stepIndex) => ({ runId, phaseIndex: this.selectedPhase, stepIndex }));
    if (records.length === 0) return;
    if (this.adapter.state !== "available") {
      for (const record of records) this.results.set(record.runId, "unavailable");
      this.onInvalidate();
      return;
    }
    await Promise.all(records.map(async ({ runId }) => {
      try {
        const result = await this.adapter.result({ runId });
        this.results.set(runId, result);
      } catch {
        this.results.set(runId, "error");
      }
    }));
    this.onInvalidate();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (data === KEY.moveDown || data === KEY.downArrow) {
      this.selectedPhase = Math.min(this.selectedPhase + 1, Math.max(0, this.run.irSnapshot.phases.length - 1));
      this.results.clear();
      void this.refresh();
    } else if (data === KEY.moveUp || data === KEY.upArrow) {
      this.selectedPhase = Math.max(0, this.selectedPhase - 1);
      this.results.clear();
      void this.refresh();
    } else if (data === KEY.escape || data === "\u0003") {
      this.dispose();
      this.onBack();
    }
  }

  invalidate(): void {
    // state is live; nothing cached
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private phaseIndicator(phaseIndex: number): string {
    const { status, phaseIndex: current, irSnapshot } = this.run;
    const n = irSnapshot.phases.length;
    if (status === "completed") return "\u2713";
    if (status === "failed" || status === "stopped") {
      return phaseIndex < current ? "\u2713" : phaseIndex === current ? "!" : phaseIndex < n ? "\u00b7" : "\u00b7";
    }
    if (phaseIndex < current) return "\u2713";
    if (phaseIndex === current) return "\u2192";
    return "\u00b7";
  }

  render(width: number): string[] {
    const run = this.run;
    const lines: string[] = [];
    const bar = BAR(width);
    lines.push(COPY.drilldown.header(run.workflowName, run.runId.slice(0, 8), run.status));
    lines.push(COPY.drilldown.started(new Date(run.startedAt).toISOString(), run.elapsedMs));
    if (run.tokenTotal !== undefined) {
      lines.push(COPY.drilldown.tokens(run.tokenTotal) + (run.totalCost !== undefined ? COPY.drilldown.cost(run.totalCost) : ""));
    }
    if (run.error) lines.push(COPY.drilldown.error(run.error));
    lines.push(bar);

    const phases = run.irSnapshot.phases;
    const visible = width > 0 ? Math.max(4, Math.floor(width / 2.5)) : 4;
    const start = Math.max(0, Math.min(this.selectedPhase - Math.floor(visible / 2), Math.max(0, phases.length - visible)));
    for (let i = start; i < Math.min(phases.length, start + visible); i++) {
      const ph = phases[i];
      const sel = i === this.selectedPhase ? "\u25b6" : " ";
      lines.push(`${sel} [${this.phaseIndicator(i)}] ${i}: ${ph.type}${ph.label ? ` (${ph.label})` : ""}`);
    }
    lines.push(bar);

    const phase = phases[this.selectedPhase];
    if (phase && phase.type === "gate") {
      lines.push(`  condition: ${phase.condition.type}${phase.condition.type === "success" ? ` on "${phase.condition.outputKey}"` : ""} \u2192 skipToPhase ${phase.skipToPhase}`);
    } else if (phase) {
      if (phase.type === "loop") {
        const until = phase.until;
        lines.push(COPY.drilldown.until(`${until.type}${until.type === "contains" ? ` "${until.outputKey}"` : ""} | maxRounds: ${phase.maxRounds}`));
      }
      const steps = phase.steps;
      for (const [i, step] of steps.entries()) {
        lines.push(COPY.drilldown.step(i, step.agent, step.task));
        const record = (run.subagentRuns?.length
          ? run.subagentRuns.find((r) => r.phaseIndex === this.selectedPhase && r.stepIndex === i)
          : run.subagentRunIds[i] ? { runId: run.subagentRunIds[i] } : undefined);
        if (record) {
          const result = this.results.get(record.runId) ?? null;
          if (result === "unavailable" || result === "error") lines.push(`     ${COPY.drilldown.dataUnavailable}`);
          else if (result !== null) {
            lines.push(COPY.drilldown.resultLine(result.state));
            if (result.ready) {
              const preview = outputPreview(result.outputAvailable ? result.output : "");
              lines.push(`     ${COPY.drilldown.output(preview)}`);
              if (result.outputTruncated) lines.push(`     ${COPY.drilldown.outputTruncated}`);
            }
          }
        }
      }
    }
    lines.push(bar);
    lines.push(COPY.drilldown.footer);
    return lines;
  }
}

function outputPreview(output: string): string {
  if (output.length === 0) return COPY.drilldown.noOutput;
  // Strip ANSI escapes and C0 control chars to prevent TUI injection
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const tail = clean.slice(-800);
  const lines = tail.split("\n").slice(-6).join("\n");
  return lines || COPY.drilldown.noOutput;
}
