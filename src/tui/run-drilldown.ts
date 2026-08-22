/**
 * RunDrilldown: readonly phase → agent detail for a WorkflowRun.
 * Data from RunStore + RPC status only; never reads pi-subagents artifacts.
 */
import type { RpcAdapter, StatusResult } from "../rpc-adapter.ts";
import type { WorkflowRun } from "../run-state.ts";

export class RunDrilldown {
  private statuses = new Map<string, StatusResult | "error" | "unavailable">();
  private selectedPhase = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly run: WorkflowRun,
    private readonly adapter: RpcAdapter,
    private readonly onBack: () => void,
    private readonly onInvalidate: () => void = () => {}
  ) {
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
    if (data === "j" || data === "down") {
      this.selectedPhase = Math.min(this.selectedPhase + 1, Math.max(0, this.run.irSnapshot.phases.length - 1));
      this.statuses.clear();
      void this.refresh();
    } else if (data === "k" || data === "up") {
      this.selectedPhase = Math.max(0, this.selectedPhase - 1);
      this.statuses.clear();
      void this.refresh();
    } else if (data === "\u001b" || data === "\u0003") {
      this.dispose();
      this.onBack();
    }
  }

  invalidate(): void {
    // state is live; nothing cached
  }

  dispose(): void {
    this.disposed = true;
  }

  private phaseIndicator(phaseIndex: number): string {
    const { status, phaseIndex: current, irSnapshot } = this.run;
    const n = irSnapshot.phases.length;
    if (status === "completed") return "✓";
    if (status === "failed" || status === "stopped") {
      return phaseIndex < current ? "✓" : phaseIndex === current ? "!" : phaseIndex < n ? "·" : "·";
    }
    if (phaseIndex < current) return "✓";
    if (phaseIndex === current) return "→";
    return "·";
  }

  render(width: number): string[] {
    const run = this.run;
    const lines: string[] = [];
    const bar = "─".repeat(Math.max(8, width - 2));
    lines.push(`Workflow: ${run.workflowName} | Run: ${run.runId.slice(0, 8)} | Status: ${run.status}`);
    lines.push(`Started ${new Date(run.startedAt).toISOString()}${run.elapsedMs !== undefined ? ` | elapsed ${(run.elapsedMs / 1000).toFixed(1)}s` : ""}`);
    if (run.tokenTotal !== undefined) lines.push(`tokens: ${run.tokenTotal}${run.totalCost !== undefined ? ` | cost: $${run.totalCost.toFixed(4)}` : ""}`);
    if (run.error) lines.push(`error: ${run.error}`);
    lines.push(bar);

    const phases = run.irSnapshot.phases;
    const visible = width > 0 ? Math.max(4, Math.floor(width / 2.5)) : 4;
    const start = Math.max(0, Math.min(this.selectedPhase - Math.floor(visible / 2), Math.max(0, phases.length - visible)));
    for (let i = start; i < Math.min(phases.length, start + visible); i++) {
      const ph = phases[i];
      const sel = i === this.selectedPhase ? "▶" : " ";
      lines.push(`${sel} [${this.phaseIndicator(i)}] ${i}: ${ph.type}${ph.label ? ` (${ph.label})` : ""}`);
    }
    lines.push(bar);

    const phase = phases[this.selectedPhase];
    if (phase && phase.type === "gate") {
      lines.push(`  condition: ${phase.condition.type}${phase.condition.type === "success" ? ` on "${phase.condition.outputKey}"` : " (unsupported at runtime)"} → skipToPhase ${phase.skipToPhase}`);
    } else if (phase) {
      if (phase.type === "loop") {
        lines.push(`  until: ${phase.until.type} | maxRounds: ${phase.maxRounds}`);
      }
      const steps = phase.steps;
      for (const [i, step] of steps.entries()) {
        lines.push(`  ${i + 1}. ${step.agent} — ${trunc(step.task, 200)}`);
        const record = (run.subagentRuns?.length
          ? run.subagentRuns.find((r) => r.phaseIndex === this.selectedPhase && r.stepIndex === i)
          : run.subagentRunIds[i] ? { runId: run.subagentRunIds[i] } : undefined);
        if (record) {
          const st = this.statuses.get(record.runId) ?? null;
          if (st === "unavailable" || st === "error") lines.push(`     [data unavailable]`);
          else if (st !== null) {
            lines.push(`     state: ${st.state}${st.totalTokens !== undefined ? ` | tokens: ${st.totalTokens}` : ""}${st.totalCost !== undefined ? ` | cost: $${st.totalCost.toFixed(4)}` : ""}`);
            if (st.steps && st.steps.length > 0) {
              for (const s of st.steps.slice(0, 8)) {
                lines.push(`       step: ${s.status}${s.tokens !== undefined ? ` (${s.tokens} tok)` : ""}`);
              }
            }
          }
        }
      }
    }
    lines.push(bar);
    lines.push("[j/k] phases  [Esc] back");
    return lines;
  }
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}