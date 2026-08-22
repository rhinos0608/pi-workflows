/**
 * BrowseTui: main `/workflows` TUI — Saved / Running / History tabs plus
 * nested run drilldown and readonly preview. Real data only; pi-subagents
 * RPC gaps render as `(pi-subagents unavailable)` / `[data unavailable]`.
 */
import type { RpcAdapter, StatusResult } from "../rpc-adapter.ts";
import type { WorkflowRun } from "../run-state.ts";
import type { RunStore } from "../run-state.ts";
import type { WorkflowRegistry } from "../registry.ts";
import { loadRegistry, loadWorkflow, type WorkflowDef } from "../persistence.ts";
import { RunDrilldown } from "./run-drilldown.ts";
import { PreviewTui, type PreviewResult } from "./preview-tui.ts";

export type BrowseResult =
  | { action: "close" }
  | { action: "create" }
  | { action: "run-workflow"; name: string; args?: string }
  | { action: "delete-workflow"; name: string; scope: "user" | "project" }
  | { action: "stop-run"; runId: string }
  | { action: "save-workflow"; def: WorkflowDef; scope: "user" | "project" }
  | { action: "restart"; run: WorkflowRun; defName: string };

type Tab = "saved" | "running" | "history";

interface SavedItem {
  entry: { name: string; scope: "user" | "project" };
  def: WorkflowDef | null;
}

interface RunInfo {
  run: WorkflowRun;
  live: StatusResult | "error" | null;
}

export class BrowseTui {
  private tab: Tab = "saved";
  private sel = 0;
  private savedCache: SavedItem[] = [];
  private runningCache: RunInfo[] = [];
  private historyCache: WorkflowRun[] = [];
  private statusNote: string | null = null;
  private confirmDelete: SavedItem | null = null;
  private argEntry: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private drilldown: RunDrilldown | null = null;
  private preview: PreviewTui | null = null;

  constructor(private readonly opts: {
    done: (result: BrowseResult) => void;
    runStore: RunStore;
    adapter: RpcAdapter;
    coordinator?: { stop(runId: string): Promise<void> };
    registry: WorkflowRegistry;
    cwd: string;
  }) {
    void opts.registry;
    this.refreshLists();
    this.timer = setInterval(() => this.refreshActive(), 2000);
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.drilldown) {
      this.drilldown.handleInput(data);
      return;
    }
    if (this.preview) {
      this.preview.handleInput(data);
      return;
    }
    if (this.confirmDelete) {
      if (data === "y") {
        const item = this.confirmDelete;
        this.confirmDelete = null;
        if (item.def) this.opts.done({ action: "delete-workflow", name: item.def.name, scope: item.def.scope });
      } else if (data === "n" || data === "\u001b") this.confirmDelete = null;
      return;
    }
    if (this.argEntry !== null) {
      if (data === "\r") {
        const item = this.savedCache[this.sel];
        const args = this.argEntry;
        this.argEntry = null;
        if (item?.def) this.opts.done({ action: "run-workflow", name: item.def.name, args });
      } else if (data === "\u007f") this.argEntry = this.argEntry.slice(0, -1);
      else if (data.length === 1 && data >= " ") this.argEntry += data;
      return;
    }
    switch (data) {
      case "1":
        this.tab = "saved";
        this.sel = 0;
        break;
      case "2":
        this.tab = "running";
        this.sel = 0;
        break;
      case "3":
        this.tab = "history";
        this.sel = 0;
        break;
      case "j":
      case "down":
        this.sel = Math.min(this.sel + 1, Math.max(0, this.listLength() - 1));
        break;
      case "k":
      case "up":
        this.sel = Math.max(0, this.sel - 1);
        break;
      case "\r":
        this.openSelected();
        break;
      case "r":
        this.runSelected();
        break;
      case "R": {
        const info = this.tab === "running" ? this.runningCache[this.sel] : null;
        if (info) this.opts.done({ action: "restart", run: info.run, defName: info.run.workflowName });
        break;
      }
      case "d": {
        const item = this.tab === "saved" ? this.savedCache[this.sel] : null;
        if (item?.def) this.confirmDelete = item;
        break;
      }
      case "s": {
        const info = this.tab === "running" ? this.runningCache[this.sel] : null;
        const canStop = Boolean(this.opts.adapter.capabilities?.stop && info?.live && info.live !== "error" && info.live.state === "running");
        if (canStop && info && this.opts.coordinator) void this.opts.coordinator.stop(info.run.runId).catch(() => { this.statusNote = "Stop failed"; });
        else this.statusNote = "Stop unavailable";
        break;
      }
      case "c":
        this.opts.done({ action: "create" });
        break;
      case "q":
      case "\u001b":
        this.close();
        break;
      default:
        break;
    }
  }

  private listLength(): number {
    const n =
      this.tab === "saved" ? this.savedCache.length
      : this.tab === "running" ? this.runningCache.length
      : this.historyCache.length;
    return Math.max(1, n);
  }

  private openSelected(): void {
    if (this.tab === "saved") {
      const item = this.savedCache[this.sel];
      if (item?.def) this.openPreview(item.def);
    } else if (this.tab === "running") {
      const info = this.runningCache[this.sel];
      if (info) this.openDrilldown(info.run);
    } else {
      const run = this.historyCache[this.sel];
      if (run) this.openDrilldown(run);
    }
  }

  private openDrilldown(run: WorkflowRun): void {
    this.drilldown = new RunDrilldown(run, this.opts.adapter, () => {
      this.drilldown = null;
      this.refreshLists();
    });
  }

  private openPreview(def: WorkflowDef): void {
    const done = (r: PreviewResult): void => {
      this.preview = null;
      if (r.action === "run") {
        this.opts.done({ action: "run-workflow", name: r.ir.name });
      } else if (r.action === "save") {
        this.opts.done({ action: "save-workflow", def, scope: r.scope });
      } else {
        this.statusNote = "Preview cancelled";
      }
    };
    this.preview = new PreviewTui(def.ir, done);
  }

  private runSelected(): void {
    if (this.tab !== "saved") return;
    const item = this.savedCache[this.sel];
    if (!item?.def) return;
    if (this.opts.adapter.state !== "available") {
      this.statusNote = "(pi-subagents unavailable) — runs are disabled";
      return;
    }
    this.argEntry = "";
  }

  private refreshLists(): void {
    const entries = loadRegistry().filter((e) => !e.deleted);
    this.savedCache = entries.map((entry) => ({
      entry: { name: entry.name, scope: entry.scope },
      def: loadWorkflow(entry.name, this.opts.cwd) ?? null,
    }));
    this.runningCache = this.opts.runStore
      .list()
      .filter((r) => r.status === "running" || r.status === "paused")
      .map((run) => ({ run, live: null }));
    this.historyCache = this.opts.runStore.loadHistory();
    const max = this.listLength() - 1;
    if (this.sel > max) this.sel = Math.max(0, max);
  }

  private refreshActive(): void {
    if (this.disposed) return;
    this.refreshLists();
    if (this.opts.adapter.state === "available") {
      for (const info of this.runningCache) {
        info.live = null;
        const ids = info.run.subagentRunIds.length > 0 ? info.run.subagentRunIds : [info.run.runId];
        for (const runId of ids) {
          void this.opts.adapter.status({ runId }).then((st) => {
            info.live = st;
            this.onInvalidate?.();
          }).catch(() => { info.live = "error"; });
        }
      }
    }
    this.onInvalidate?.();
  }

  private onInvalidate: (() => void) | null = null;

  wireInvalidate(fn: () => void): void {
    this.onInvalidate = fn;
  }

  invalidate(): void {
    // stateless render; live data refreshes on the 2s timer
  }

  private close(): void {
    this.dispose();
    this.opts.done({ action: "close" });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.drilldown?.dispose();
    this.drilldown = null;
    this.preview = null;
  }

  render(width: number): string[] {
    if (this.drilldown) return this.drilldown.render(width);
    if (this.preview) return this.preview.render(width);

    const lines: string[] = [];
    lines.push(`[1] Saved (${this.savedCache.length})   [2] Running (${this.runningCache.length})   [3] History (${this.historyCache.length})`);
    if (this.opts.adapter.state !== "available") {
      lines.push("(pi-subagents unavailable — Run controls disabled)");
    }
    if (this.confirmDelete) lines.push(`Delete ${this.confirmDelete.def?.name ?? "workflow"}? [y/n]`);
    if (this.argEntry !== null) lines.push(`Arguments: ${this.argEntry} (Enter to run, Esc to cancel)`);
    if (this.statusNote) lines.push(`note: ${this.statusNote}`);
    lines.push("─".repeat(Math.max(8, width - 2)));

    try {
      if (this.tab === "saved") {
        if (this.savedCache.length === 0) {
          lines.push("  (no saved workflows — run /workflows create)");
        } else {
          for (const [i, item] of this.savedCache.entries()) {
            const sel = i === this.sel ? "▶" : " ";
            const scope = item.entry.scope === "project" ? "project" : "user";
            const name = item.def ? item.def.name : `${item.entry.name} [load error]`;
            lines.push(`${sel} ${name} (${scope})`);
          }
        }
      } else if (this.tab === "running") {
        if (this.runningCache.length === 0) {
          lines.push("  (no active runs)");
        } else {
          for (const [i, info] of this.runningCache.entries()) {
            const sel = i === this.sel ? "▶" : " ";
            const r = info.run;
            const state = info.live && info.live !== "error" ? info.live.state : r.status;
            lines.push(`${sel} ${trunc(r.workflowName, 24)} | ${r.runId.slice(0, 8)} | ${state}`);
          }
        }
      } else {
        if (this.historyCache.length === 0) {
          lines.push("  (no run history)");
        } else {
          for (const [i, run] of this.historyCache.entries()) {
            const sel = i === this.sel ? "▶" : " ";
            const icon = run.status === "completed" ? "✓" : run.status === "failed" ? "!" : run.status === "stopped" ? "■" : "·";
            const elapsed = run.elapsedMs !== undefined ? `${(run.elapsedMs / 1000).toFixed(0)}s` : "?";
            const tokens = run.tokenTotal !== undefined ? ` | ${run.tokenTotal} tok` : "";
            lines.push(`${sel} ${icon} ${trunc(run.workflowName, 20)} | ${run.runId.slice(0, 8)} | ${elapsed}${tokens}`);
          }
        }
      }
    } catch {
      lines.push("  [data unavailable]");
    }

    lines.push("─".repeat(Math.max(8, width - 2)));
    const runAllowed = this.opts.adapter.state === "available";
    const selected = this.tab === "running" ? this.runningCache[this.sel] : null;
    const stopAllowed = Boolean(runAllowed && this.opts.adapter.capabilities?.stop && selected?.live && selected.live !== "error" && selected.live.state === "running");
    lines.push(runAllowed ? `[r] Run  [s] Stop${stopAllowed ? "" : " (unavailable)"}  [R] Restart  [d] Delete  [Enter] open  [c] Create  [q] Quit` : "[r] Run (disabled: pi-subagents unavailable)  [R] Restart  [d] Delete  [Enter] open  [c] Create  [q] Quit");
    if (this.runningCache.some((i) => i.run.status === "paused")) lines.push("Pause/resume unavailable: pi-subagents RPC v1 has no resume method.");
    return lines;
  }
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}