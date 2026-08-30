/**
 * BrowseTui: main `/workflows` TUI — Saved / Running / History tabs plus
 * nested run drilldown and phase preview/editor. Real data only; pi-subagents
 * RPC gaps render truthfully as unavailable / empty / error states.
 *
 * Screen model is an explicit discriminated union: either the list screen
 * (with at most one overlay at a time) or a single child TUI (drilldown /
 * preview) — conflicting modes cannot co-exist. All copy and key bindings
 * live in ./text.ts.
 */
import type { RpcAdapter } from "../rpc-adapter.ts";
import type { WorkflowRun } from "../run-state.ts";
import type { RunStore } from "../run-state.ts";
import type { WorkflowRegistry } from "../registry.ts";
import { loadRegistry, loadWorkflow, type WorkflowDef } from "../persistence.ts";
import type { WorkflowIR } from "../ir.ts";
import { RunDrilldown } from "./run-drilldown.ts";
import { PreviewTui, type PreviewResult } from "./preview-tui.ts";
import { BAR, COPY, KEY, TextEntry, isPrintable } from "./text.ts";

export type BrowseResult =
  | { action: "close" }
  | { action: "create"; description: string }
  | { action: "run-workflow"; name: string; args?: string; ir?: WorkflowIR }
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
}

type BrowseOverlay =
  | { kind: "confirm-delete"; item: SavedItem }
  | { kind: "arg-entry"; entry: TextEntry; error: string | null }
  | { kind: "create-description"; entry: TextEntry; error: string | null };

type BrowseScreen =
  | { kind: "list"; overlay: BrowseOverlay | null }
  | { kind: "drilldown"; tui: RunDrilldown }
  | { kind: "preview"; tui: PreviewTui };

export interface BrowseTuiOptions {
  done: (result: BrowseResult) => void;
  runStore: RunStore;
  adapter: RpcAdapter;
  coordinator?: { stop(runId: string): Promise<void> };
  registry: WorkflowRegistry;
  cwd: string;
}

export class BrowseTui {
  private readonly opts: BrowseTuiOptions;
  private tab: Tab = "saved";
  private sel = 0;
  private savedCache: SavedItem[] = [];
  private runningCache: RunInfo[] = [];
  private historyCache: WorkflowRun[] = [];
  private note: { kind: "note" | "error"; text: string } | null = null;
  private screen: BrowseScreen = { kind: "list", overlay: null };
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private onInvalidate: (() => void) | null = null;

  constructor(opts: BrowseTuiOptions) {
    this.opts = opts;
    this.refreshLists();
    this.timer = setInterval(() => this.refreshActive(), 2000);
  }

  get rpcAvailable(): boolean {
    return this.opts.adapter.state === "available";
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const screen = this.screen;
    if (screen.kind === "drilldown") {
      screen.tui.handleInput(data);
      return;
    }
    if (screen.kind === "preview") {
      screen.tui.handleInput(data);
      return;
    }
    const overlay = screen.overlay;
    if (overlay) {
      this.handleOverlay(overlay, data);
      return;
    }
    this.handleList(data);
  }

  private handleOverlay(overlay: BrowseOverlay, data: string): void {
    switch (overlay.kind) {
      case "confirm-delete":
        if (data === KEY.yes) {
          const item = overlay.item;
          if (item.def) {
            this.screen = { kind: "list", overlay: null };
            this.note = { kind: "note", text: COPY.browse.deleteDone(item.def.name) };
            this.opts.done({ action: "delete-workflow", name: item.def.name, scope: item.def.scope });
          }
        } else if (data === KEY.no || data === KEY.escape) {
          this.screen = { kind: "list", overlay: null };
        }
        break;
      case "arg-entry":
        if (data === KEY.confirm) {
          const item = this.savedCache[this.sel];
          const args = overlay.entry.value;
          this.screen = { kind: "list", overlay: null };
          if (item?.def) {
            this.opts.done({ action: "run-workflow", name: item.def.name, args });
          }
        } else if (data === KEY.escape) {
          this.screen = { kind: "list", overlay: null };
        } else if (data === KEY.backspace) {
          overlay.entry.backspace();
        } else if (data === KEY.left) {
          overlay.entry.left();
        } else if (data === KEY.right) {
          overlay.entry.right();
        } else if (isPrintable(data)) {
          overlay.entry.insert(data);
        }
        break;
      case "create-description":
        if (data === KEY.confirm) {
          const description = overlay.entry.value;
          if (description.trim() === "") {
            overlay.error = COPY.browse.createEmptyError; // validation state: stay
            return;
          }
          this.opts.done({ action: "create", description }); // exact text, no trimming
        } else if (data === KEY.escape) {
          this.screen = { kind: "list", overlay: null }; // cancel overlay only
        } else if (data === KEY.backspace) {
          overlay.entry.backspace();
        } else if (data === KEY.left) {
          overlay.entry.left();
        } else if (data === KEY.right) {
          overlay.entry.right();
        } else if (isPrintable(data)) {
          overlay.entry.insert(data);
        }
        break;
    }
  }

  private handleList(data: string): void {
    switch (data) {
      case KEY.tabSaved:
        this.tab = "saved";
        this.sel = 0;
        break;
      case KEY.tabRunning:
        this.tab = "running";
        this.sel = 0;
        break;
      case KEY.tabHistory:
        this.tab = "history";
        this.sel = 0;
        break;
      case KEY.moveDown:
      case KEY.downArrow:
        this.sel = Math.min(this.sel + 1, Math.max(0, this.listLength() - 1));
        break;
      case KEY.moveUp:
      case KEY.upArrow:
        this.sel = Math.max(0, this.sel - 1);
        break;
      case KEY.open:
        this.openSelected();
        break;
      case KEY.run:
        this.runSelected();
        break;
      case KEY.restart: {
        const info = this.tab === "running" ? this.runningCache[this.sel] : null;
        if (info) this.opts.done({ action: "restart", run: info.run, defName: info.run.workflowName });
        break;
      }
      case KEY.delete: {
        const item = this.tab === "saved" ? this.savedCache[this.sel] : null;
        if (item?.def) {
          this.screen = { kind: "list", overlay: { kind: "confirm-delete", item } };
        } else {
          this.note = this.tab === "saved" ? { kind: "note", text: COPY.browse.emptySaved() } : null;
        }
        break;
      }
      case KEY.stop: {
        const info = this.tab === "running" ? this.runningCache[this.sel] : null;
        const canStop =
          Boolean(this.opts.adapter.capabilities?.stop) &&
          info?.run.status === "running";
        if (canStop && info && this.opts.coordinator) {
          void this.opts.coordinator.stop(info.run.runId).catch(() => {
            this.note = { kind: "error", text: COPY.browse.stopFailed };
          });
        } else {
          this.note = { kind: "error", text: COPY.browse.stopUnavailable };
        }
        break;
      }
      case KEY.create:
        this.screen = { kind: "list", overlay: { kind: "create-description", entry: new TextEntry(), error: null } };
        break;
      case KEY.quit:
      case KEY.escape:
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
    this.screen = {
      kind: "drilldown",
      tui: new RunDrilldown(run, this.opts.adapter, () => {
        this.screen = { kind: "list", overlay: null };
        this.refreshLists();
        this.onInvalidate?.();
      }),
    };
  }

  private openPreview(def: WorkflowDef): void {
    const done = (r: PreviewResult): void => {
      this.screen = { kind: "list", overlay: null };
      if (r.action === "run") {
        // Carry the EDITED IR: run exactly what the preview assembled, not
        // the original on-disk def.
        this.opts.done({ action: "run-workflow", name: r.ir.name, ir: r.ir });
      } else if (r.action === "save") {
        this.opts.done({ action: "save-workflow", def: { ...def, ir: r.ir }, scope: r.scope });
      } else {
        this.note = { kind: "note", text: COPY.browse.previewCancelled };
      }
    };
    this.screen = {
      kind: "preview",
      tui: new PreviewTui(def.ir, done, { rpcAvailable: this.rpcAvailable }),
    };
  }

  private runSelected(): void {
    if (this.tab !== "saved") return;
    const item = this.savedCache[this.sel];
    if (!item?.def) return;
    if (!this.rpcAvailable) {
      this.note = { kind: "error", text: COPY.browse.runDisabled };
      return;
    }
    this.screen = { kind: "list", overlay: { kind: "arg-entry", entry: new TextEntry(), error: null } };
  }

  private refreshLists(): void {
    const entries = loadRegistry().filter((e) => !e.deleted);
    this.savedCache = entries.map((entry) => ({
      entry: { name: entry.name, scope: entry.scope },
      def: entry.deleted ? null : (loadWorkflow(entry.name, this.opts.cwd) ?? null),
    }));
    this.runningCache = this.opts.runStore
      .list()
      .filter((r) => r.status === "running" || r.status === "paused")
      .map((run) => ({ run }));
    this.historyCache = this.opts.runStore.loadHistory();
    const max = this.listLength() - 1;
    if (this.sel > max) this.sel = Math.max(0, max);
  }

  private refreshActive(): void {
    if (this.disposed) return;
    this.refreshLists();
    this.onInvalidate?.();
  }

  /** Beware: render is overridden by children when nested; see render(). */
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
    const screen = this.screen;
    if (screen.kind === "drilldown") screen.tui.dispose();
    this.screen = { kind: "list", overlay: null };
  }

  render(width: number): string[] {
    const screen = this.screen;
    if (screen.kind === "drilldown") return screen.tui.render(width);
    if (screen.kind === "preview") return screen.tui.render(width);

    const overlay = screen.overlay;
    if (overlay && (overlay.kind === "arg-entry" || overlay.kind === "create-description")) {
      return this.renderEntry(width, overlay);
    }
    return this.renderList(width, overlay);
  }

  private renderEntry(width: number, overlay: Extract<BrowseOverlay, { kind: "arg-entry" | "create-description" }>): string[] {
    const lines: string[] = [];
    if (overlay.kind === "create-description") {
      lines.push(COPY.browse.createTitle);
      lines.push(COPY.browse.createPrompt);
      lines.push(COPY.browse.createInput(overlay.entry.line()));
      if (overlay.error) lines.push(`! ${overlay.error}`);
      lines.push(COPY.browse.createHelp);
    } else {
      lines.push(COPY.browse.argEntry(overlay.entry.line()));
      lines.push(COPY.browse.createHelp.replace("[Enter] Generate", `${KEY.confirm} run`));
    }
    return lines;
  }

  private renderList(width: number, overlay: BrowseOverlay | null): string[] {
    const lines: string[] = [];
    lines.push(COPY.browse.tabs(this.savedCache.length, this.runningCache.length, this.historyCache.length));
    if (!this.rpcAvailable) lines.push(COPY.browse.rpcNote);
    if (this.note) lines.push(COPY.browse[this.note.kind](this.note.text));
    if (overlay?.kind === "confirm-delete") {
      lines.push(COPY.browse.deleteConfirm(overlay.item.def?.name ?? "workflow"));
    }
    lines.push(BAR(width));

    try {
      if (this.tab === "saved") {
        if (this.savedCache.length === 0) {
          lines.push(`  ${COPY.browse.emptySaved()}`);
        } else {
          for (const [i, item] of this.savedCache.entries()) {
            const sel = i === this.sel ? "\u25b6" : " ";
            const scope = item.entry.scope === "project" ? "project" : "user";
            const name = item.def ? item.def.name : `${item.entry.name} ${COPY.browse.loadError}`;
            lines.push(`${sel} ${name} (${scope})`);
          }
        }
      } else if (this.tab === "running") {
        if (this.runningCache.length === 0) {
          lines.push(`  ${COPY.browse.emptyRunning}`);
        } else {
          for (const [i, info] of this.runningCache.entries()) {
            const sel = i === this.sel ? "\u25b6" : " ";
            const r = info.run;
            const state = r.status;
            lines.push(`${sel} ${trunc(r.workflowName, 24)} | ${r.runId.slice(0, 8)} | ${state}`);
          }
        }
      } else {
        if (this.historyCache.length === 0) {
          lines.push(`  ${COPY.browse.emptyHistory}`);
        } else {
          for (const [i, run] of this.historyCache.entries()) {
            const sel = i === this.sel ? "\u25b6" : " ";
            const icon = run.status === "completed" ? "\u2713" : run.status === "failed" ? "!" : run.status === "stopped" ? "\u25a0" : "\u00b7";
            const elapsed = run.elapsedMs !== undefined ? `${(run.elapsedMs / 1000).toFixed(0)}s` : "?";
            const tokens = run.tokenTotal !== undefined ? ` | ${run.tokenTotal} tok` : "";
            lines.push(`${sel} ${icon} ${trunc(run.workflowName, 20)} | ${run.runId.slice(0, 8)} | ${elapsed}${tokens}`);
          }
        }
      }
    } catch {
      lines.push(`  ${COPY.browse.dataUnavailable}`);
    }

    lines.push(BAR(width));
    lines.push(this.rpcAvailable ? COPY.browse.footerAvailable : COPY.browse.footerRpcOff);
    return lines;
  }
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\u2026`;
}