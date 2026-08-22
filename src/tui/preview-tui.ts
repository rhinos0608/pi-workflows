/**
 * PreviewTui: IR preview + scope select + explicit approval for model drafts.
 * Renders as a plain Component (structural typing; no pi-tui value imports).
 */
import type { WorkflowIR } from "../ir.ts";
import { RESERVED_PI_NAMES, MAX_WORKFLOW_NAME_LEN } from "../constants.ts";

export type PreviewResult =
  | { action: "run"; ir: WorkflowIR; scope: "user" | "project" }
  | { action: "save"; ir: WorkflowIR; scope: "user" | "project" }
  | { action: "cancel" };

interface Line {
  text: string;
  dim?: boolean;
}

export class PreviewTui {
  readonly ir: WorkflowIR;
  private readonly done: (result: PreviewResult) => void;
  private scope: "user" | "project" = "user";
  private phaseScroll = 0;
  private error: string | null = null;
  private finished = false;

  constructor(ir: WorkflowIR, done: (result: PreviewResult) => void) {
    this.ir = ir;
    this.done = done;
  }

  private validateName(): string | null {
    const n = this.ir.name;
    if (!/^[a-zA-Z0-9_-]+$/.test(n) || n.length === 0) return `Invalid name "${n}": must match [a-zA-Z0-9_-]+`;
    if (n.length > MAX_WORKFLOW_NAME_LEN) return `Name too long (>${MAX_WORKFLOW_NAME_LEN})`;
    if (RESERVED_PI_NAMES.has(n)) return `Name "${n}" is reserved by Pi; edit and re-submit`;
    return null;
  }

  handleInput(data: string): void {
    if (this.finished) return;
    switch (data) {
      case "u":
        this.scope = "user";
        break;
      case "p":
        this.scope = "project";
        break;
      case "j":
      case "down":
        this.phaseScroll = Math.min(this.phaseScroll + 1, Math.max(0, this.ir.phases.length - 1));
        break;
      case "k":
      case "up":
        this.phaseScroll = Math.max(0, this.phaseScroll - 1);
        break;
      case "r":
      case "s": {
        const err = this.validateName();
        if (err) {
          this.error = err;
          return;
        }
        this.finished = true;
        this.done({ action: data === "r" ? "run" : "save", ir: this.ir, scope: this.scope });
        break;
      }
      case "c":
      case "\u001b": // Escape
        this.finished = true;
        this.done({ action: "cancel" });
        break;
      default:
        this.error = null;
    }
  }

  invalidate(): void {
    // stateless render; nothing cached
  }

  render(width: number): string[] {
    const lines: Line[] = [];
    const bar = "─".repeat(Math.max(8, width - 2));
    lines.push({ text: `Preview: ${this.ir.name} (v${this.ir.version})` });
    if (this.ir.description) lines.push({ text: this.ir.description, dim: true });
    lines.push({ text: bar, dim: true });
    lines.push({ text: `Scope: ${this.scope === "user" ? "user (~/.pi/agent/pi-workflows/saved/)" : "project (.pi/workflows/)"}` });
    lines.push({ text: bar, dim: true });

    const visible = width > 0 ? Math.max(4, Math.floor(width / 3)) : 4;
    const start = Math.min(this.phaseScroll, Math.max(0, this.ir.phases.length - visible));
    for (let i = start; i < Math.min(this.ir.phases.length, start + visible); i++) {
      const ph = this.ir.phases[i];
      const steps = ph.type === "sequential" || ph.type === "parallel" || ph.type === "loop" ? ph.steps.length : undefined;
      const stepTxt = steps !== undefined ? ` (steps: ${steps})` : "";
      const mark = i === this.phaseScroll ? "▶" : " ";
      lines.push({ text: `${mark} [${i}] ${ph.type}: ${ph.label ?? ph.type}${stepTxt}` });
    }

    if (this.ir.args) {
      const keys = Object.keys(this.ir.args);
      if (keys.length > 0) {
        lines.push({ text: bar, dim: true });
        lines.push({ text: "Args:" });
        for (const k of keys) {
          const a = this.ir.args[k];
          const req = a.required ? " (required)" : "";
          lines.push({ text: `  ${k}: ${a.type}${req}${a.default !== undefined ? ` = ${JSON.stringify(a.default)}` : ""}` });
        }
      }
    }

    lines.push({ text: bar, dim: true });
    if (this.error) {
      lines.push({ text: `! ${this.error}` });
    }
    lines.push({ text: "[r] Run  [s] Save  [c] Cancel  [u/p] Scope  [j/k] phases" });
    return lines.map((l) => (l.dim ? dim(l.text) : l.text));
  }
}

/** Minimal dim marker using ANSI (TUI passes strings through; terminals strip nothing). */
function dim(text: string): string {
  return `\u001b[2m${text}\u001b[0m`;
}