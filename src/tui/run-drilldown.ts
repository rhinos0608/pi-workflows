/**
 * RunDrilldown: readonly phase → agent detail for a WorkflowRun.
 * Data from RunStore + RPC status only; never reads pi-subagents artifacts.
 * RPC-gap states render truthfully as "[data unavailable]".
 */
import type { RpcAdapter, StatusResult } from "../rpc-adapter.ts";
import type { WorkflowRun } from "../run-state.ts";
import { BAR, COPY, KEY } from "./text.ts";

export class RunDrilldown {
  private readonly run: WorkflowRun;
  private readonly adapter: RpcAdapter;
  private readonly onBack: () => void;
  private readonly onInvalidate: () => void;
  private statuses = new Map<string, StatusResult | "error" | "unavailable">();
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
      for (const record of records) this.statuses.set(record.runId, "unavailable");
      this.onInvalidate();
      return;
    }
    await Promise.all(records.map(async ({ runId }) => {
      try {
        const st = await this.adapter.status({ runId });
        this.statuses.set(runId, st);
      } catch {
        this.statuses.set(runId, "error");
      }
    }));
    this.onInvalidate();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (data === KEY.moveDown || data === KEY.downArrow) {
      this.selectedPhase = Math.min(this.selectedPhase + 1, Math.max(0, this.run.irSnapshot.phases.length - 1));
      this.statuses.clear();
      void this.refresh();
    } else if (data === KEY.moveUp || data === KEY.upArrow) {
      this.selectedPhase = Math.max(0, this.selectedPhase - 1);
      this.statuses.clear();
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
      lines.push(`  condition: ${phase.condition.type}${phase.condition.type === "success" ? ` on "${phase.condition.outputKey}"` : " (unsupported at runtime)"} \u2192 skipToPhase ${phase.skipToPhase}`);
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
          const st = this.statuses.get(record.runId) ?? null;
          if (st === "unavailable" || st === "error") lines.push(`     ${COPY.drilldown.dataUnavailable}`);
          else if (st !== null) {
            lines.push(COPY.drilldown.statusLine(st.state, st.totalTokens, st.totalCost));
            if (st.steps && st.steps.length > 0) {
              for (const s of st.steps.slice(0, 8)) {
                lines.push(COPY.drilldown.stepLine(s.status, s.tokens));
              }
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