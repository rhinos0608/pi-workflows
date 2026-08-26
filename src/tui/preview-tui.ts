/**
 * PreviewTui: IR preview + phase editor + scope select + explicit approval.
 *
 * Edits (e / a / d / J / K) mutate a private working copy of the IR; the
 * assembled IR is validated with `validate()` before `run`/`save` ever
 * resolves, so an invalid edit can never persist or spawn. Gate
 * conditions are deliberately read-only (edge editing would broaden the
 * ir-schema scope); the UI states that.
 *
 * Renders as a plain Component (structural typing; no pi-tui value imports).
 */
import { validate, type WorkflowIR, type Phase, type Step } from "../ir.ts";
import { RESERVED_PI_NAMES, MAX_WORKFLOW_NAME_LEN } from "../constants.ts";
import { BAR, COPY, KEY, MOVE_DOWN, MOVE_UP, TextEntry, isPrintable } from "./text.ts";

export type PreviewResult =
  | { action: "run"; ir: WorkflowIR; scope: "user" | "project" }
  | { action: "save"; ir: WorkflowIR; scope: "user" | "project" }
  | { action: "cancel" };

export interface PreviewTuiOptions {
  /** Truthful run availability (adapter state) known to the opener. */
  rpcAvailable?: boolean;
}

type EditTarget =
  | { kind: "label"; phaseIndex: number }
  | { kind: "step"; phaseIndex: number; index: number; field: "agent" | "task" };

type PreviewMode =
  | { kind: "browse" }
  | { kind: "edit-pick"; phaseIndex: number; pick: number }
  | { kind: "edit-text"; target: EditTarget; entry: TextEntry; error: string | null }
  | { kind: "add"; stage: "agent" | "task"; agent: string; entry: TextEntry; error: string | null }
  | { kind: "confirm-delete"; phaseIndex: number };

const AGENT_MAX = 256;
const TASK_MAX = 4000;
const LABEL_MAX = 200;

export class PreviewTui {
  /** Working copy (cloned from the caller's IR). Edits mutate this. */
  readonly ir: WorkflowIR;
  private readonly done: (result: PreviewResult) => void;
  private readonly rpcAvailable: boolean;
  private scope: "user" | "project" = "user";
  private sel = 0;
  private mode: PreviewMode = { kind: "browse" };
  private error: string | null = null;
  private finished = false;

  constructor(ir: WorkflowIR, done: (result: PreviewResult) => void, opts: PreviewTuiOptions = {}) {
    this.ir = structuredClone(ir);
    this.done = done;
    this.rpcAvailable = opts.rpcAvailable ?? true;
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
    switch (this.mode.kind) {
      case "browse":
        this.handleBrowse(data);
        break;
      case "edit-pick":
        this.handleEditPick(data);
        break;
      case "edit-text":
        this.handleEditText(data);
        break;
      case "add":
        this.handleAdd(data);
        break;
      case "confirm-delete":
        this.handleConfirmDelete(data);
        break;
    }
  }

  private handleBrowse(data: string): void {
    switch (data) {
      case KEY.scopeUser:
        this.scope = "user";
        break;
      case KEY.scopeProject:
        this.scope = "project";
        break;
      case KEY.moveDown:
      case KEY.downArrow:
        this.sel = Math.min(this.sel + 1, Math.max(0, this.ir.phases.length - 1));
        break;
      case KEY.moveUp:
      case KEY.upArrow:
        this.sel = Math.max(0, this.sel - 1);
        break;
      case KEY.edit: {
        const phaseIndex = this.sel;
        this.mode = { kind: "edit-pick", phaseIndex, pick: 0 };
        this.error = null;
        break;
      }
      case KEY.add:
        this.mode = { kind: "add", stage: "agent", agent: "", entry: new TextEntry(), error: null };
        this.error = null;
        break;
      case KEY.delete:
        if (this.ir.phases.length <= 1) {
          this.error = COPY.preview.deleteLastError;
        } else {
          this.mode = { kind: "confirm-delete", phaseIndex: this.sel };
          this.error = null;
        }
        break;
      case KEY.reorderDown:
        if (this.sel < this.ir.phases.length - 1) {
          this.swap(this.sel, this.sel + 1);
          this.sel++;
        }
        break;
      case KEY.reorderUp:
        if (this.sel > 0) {
          this.swap(this.sel - 1, this.sel);
          this.sel--;
        }
        break;
      case KEY.run:
      case KEY.save: {
        if (data === KEY.run && !this.rpcAvailable) {
          this.error = COPY.preview.runUnavailableNote;
          return;
        }
        const nameErr = this.validateName();
        if (nameErr) {
          this.error = nameErr;
          return;
        }
        const res = validate(this.ir);
        if (!res.ok) {
          this.error = res.errors.join("; ");
          return;
        }
        this.finished = true;
        this.done({ action: data === KEY.run ? "run" : "save", ir: this.ir, scope: this.scope });
        break;
      }
      case KEY.escape:
        this.finished = true;
        this.done({ action: "cancel" });
        break;
      default:
        this.error = null;
    }
  }

  private handleEditPick(data: string): void {
    const mode = this.mode as Extract<PreviewMode, { kind: "edit-pick" }>;
    const targets = this.targetsFor(mode.phaseIndex);
    if (data === KEY.moveDown || data === KEY.downArrow) {
      mode.pick = Math.min(mode.pick + 1, targets.length - 1);
    } else if (data === KEY.moveUp || data === KEY.upArrow) {
      mode.pick = Math.max(0, mode.pick - 1);
    } else if (data === KEY.confirm) {
      this.mode = { kind: "edit-text", target: targets[mode.pick], entry: new TextEntry(this.currentValue(targets[mode.pick])), error: null };
      this.error = null;
    } else if (data === KEY.escape) {
      this.mode = { kind: "browse" };
    } else {
      this.error = null;
    }
  }

  private handleEditText(data: string): void {
    const mode = this.mode as Extract<PreviewMode, { kind: "edit-text" }>;
    const cap = mode.target.kind === "label" ? LABEL_MAX : mode.target.field === "agent" ? AGENT_MAX : TASK_MAX;
    if (data === KEY.confirm) {
      const value = mode.entry.value.trim();
      if (value === "" && mode.target.kind !== "label") {
        mode.error = mode.target.field === "agent" ? COPY.preview.stepAgentEmptyError : COPY.preview.stepTaskEmptyError;
        return;
      }
      this.commitText(mode.target, value);
      this.mode = { kind: "browse" };
      this.error = null;
    } else if (data === KEY.escape) {
      this.mode = { kind: "browse" };
      this.error = null;
    } else if (data === KEY.left) {
      mode.entry.left();
    } else if (data === KEY.right) {
      mode.entry.right();
    } else if (data === KEY.backspace) {
      mode.entry.backspace();
    } else if (isPrintable(data) && mode.entry.value.length < cap) {
      mode.entry.insert(data);
    }
  }

  private handleAdd(data: string): void {
    const mode = this.mode as Extract<PreviewMode, { kind: "add" }>;
    const cap = mode.stage === "agent" ? AGENT_MAX : TASK_MAX;
    if (data === KEY.confirm) {
      if (mode.stage === "agent") {
        const value = mode.entry.value.trim();
        if (value === "") {
          mode.error = COPY.preview.addAgentEmptyError;
          return;
        }
        mode.agent = value;
        mode.stage = "task";
        mode.entry.set("");
        mode.error = null;
        return;
      }
      const value = mode.entry.value.trim();
      if (value === "") {
        mode.error = COPY.preview.addTaskEmptyError;
        return;
      }
      const insertAt = this.sel + 1;
      const ok = this.tryMutate((clone) => {
        clone.phases.splice(insertAt, 0, { type: "sequential", steps: [{ agent: mode.agent, task: value }] });
      });
      if (ok) {
        this.mode = { kind: "browse" };
        this.error = null;
        this.sel = Math.min(insertAt, this.ir.phases.length - 1);
      }
    } else if (data === KEY.escape) {
      this.mode = { kind: "browse" };
      this.error = null;
    } else if (data === KEY.backspace) {
      mode.entry.backspace();
    } else if (isPrintable(data) && mode.entry.value.length < cap) {
      mode.entry.insert(data);
    }
  }

  private handleConfirmDelete(data: string): void {
    const mode = this.mode as Extract<PreviewMode, { kind: "confirm-delete" }>;
    if (data === KEY.yes) {
      const removed = mode.phaseIndex;
      const ok = this.tryMutate((clone) => clone.phases.splice(removed, 1));
      if (ok) {
        this.sel = Math.min(this.sel, this.ir.phases.length - 1);
        this.mode = { kind: "browse" };
        this.error = null;
      }
    } else if (data === KEY.no || data === KEY.escape) {
      this.mode = { kind: "browse" };
      this.error = null;
    }
  }

  // --- structural edits, always validated ---

  private tryMutate(mutator: (clone: WorkflowIR) => void): boolean {
    const clone = structuredClone(this.ir);
    mutator(clone);
    const res = validate(clone);
    if (!res.ok) {
      this.error = `edit blocked: ${res.errors[0]}`;
      return false;
    }
    this.ir.phases = clone.phases;
    this.error = null;
    return true;
  }

  private commitText(target: EditTarget, value: string): void {
    const phaseIndex = target.phaseIndex;
    this.tryMutate((clone) => {
      const phase = clone.phases[phaseIndex] as Phase;
      if (target.kind === "label") {
        if (value === "") {
          delete (phase as Record<string, unknown>).label; // optional field cleared
        } else {
          phase.label = value;
        }
      } else {
        const steps = (phase as { steps: Step[] }).steps;
        steps[target.index] = { ...steps[target.index], [target.field]: value };
      }
    });
  }

  private swap(a: number, b: number): void {
    this.tryMutate((clone) => {
      const tmp = clone.phases[a];
      clone.phases[a] = clone.phases[b];
      clone.phases[b] = tmp;
    });
  }

  private targetsFor(phaseIndex: number): EditTarget[] {
    const phase = this.ir.phases[phaseIndex];
    const out: EditTarget[] = [{ kind: "label", phaseIndex }];
    if ("steps" in phase && Array.isArray(phase.steps)) {
      for (const [i] of phase.steps.entries()) {
        out.push({ kind: "step", phaseIndex, index: i, field: "agent" });
        out.push({ kind: "step", phaseIndex, index: i, field: "task" });
      }
    }
    return out;
  }

  private currentValue(target: EditTarget): string {
    if (target.kind === "label") return this.ir.phases[target.phaseIndex].label ?? "";
    const phase = this.ir.phases[target.phaseIndex] as { steps: Step[] };
    return target.field === "agent" ? phase.steps[target.index].agent : phase.steps[target.index].task;
  }

  private targetLabel(target: EditTarget): string {
    if (target.kind === "label") return COPY.preview.editPickLabel(target.phaseIndex);
    return COPY.preview.editPickStep(target.index, target.field);
  }

  private targetPrompt(target: EditTarget): string {
    if (target.kind === "label") return COPY.preview.editLabelPrompt;
    return target.field === "agent" ? COPY.preview.editAgentPrompt : COPY.preview.editTaskPrompt;
  }

  invalidate(): void {
    // stateless render; nothing cached
  }

  hasGate(): boolean {
    return this.ir.phases.some((p) => p.type === "gate");
  }

  render(width: number): string[] {
    const mode = this.mode;
    switch (mode.kind) {
      case "edit-pick":
        return this.renderEditPick(width, mode);
      case "edit-text":
        return this.renderEditText(width, mode);
      case "add":
        return this.renderAdd(width, mode);
      case "confirm-delete":
        return this.renderConfirmDelete(width, mode);
      default:
        return this.renderBrowse(width);
    }
  }

  private baseLines(width: number): string[] {
    const lines: string[] = [];
    const bar = BAR(width);
    lines.push(COPY.preview.title(this.ir.name, this.ir.version));
    if (this.ir.description) lines.push(this.ir.description);
    lines.push(bar);
    lines.push(COPY.preview.scope(this.scope));
    lines.push(bar);
    const visible = width > 0 ? Math.max(4, Math.floor(width / 3)) : 4;
    const start = Math.min(this.sel, Math.max(0, this.ir.phases.length - visible));
    for (let i = start; i < Math.min(this.ir.phases.length, start + visible); i++) {
      const ph = this.ir.phases[i];
      const steps = "steps" in ph ? (ph.steps as Step[]).length : undefined;
      const mark = i === this.sel ? "\u25b6" : " ";
      const label = ph.label ?? ph.type;
      lines.push(`${mark} [${i}] ${ph.type}: ${label}${COPY.preview.phaseType(ph, steps)}`);
    }
    // Inspect selection: selected phase detail.
    const phase = this.ir.phases[this.sel];
    if (phase) {
      if (phase.type === "gate") {
        lines.push(`  condition: ${phase.condition.type}${phase.condition.type === "success" ? ` on "${phase.condition.outputKey}"` : ""} (read-only)`);
      } else if ("steps" in phase) {
        for (const [i, step] of (phase.steps as Step[]).entries()) {
          lines.push(`  step ${i + 1}: ${step.agent} \u2014 ${step.task}`);
        }
        if ((phase as { until?: unknown }).until) {
          const until = (phase as { until: { type: string; outputKey?: string } }).until;
          lines.push(`  until: ${until.type}${until.outputKey !== undefined ? ` on "${until.outputKey}"` : ""} | maxRounds: ${(phase as { maxRounds?: number }).maxRounds ?? "?"}`);
        }
      }
    }
    if (this.hasGate()) lines.push(COPY.preview.gateReadOnly);
    if (this.ir.args) {
      const keys = Object.keys(this.ir.args);
      if (keys.length > 0) {
        lines.push(bar);
        lines.push("Args:");
        for (const k of keys) {
          const a = this.ir.args[k];
          const req = a.required ? " (required)" : "";
          lines.push(`  ${k}: ${a.type}${req}${a.default !== undefined ? ` = ${JSON.stringify(a.default)}` : ""}`);
        }
      }
    }
    return lines;
  }

  private renderBrowse(width: number): string[] {
    const lines = this.baseLines(width);
    const bar = BAR(width);
    lines.push(bar);
    if (this.error) lines.push(`! ${this.error}`);
    if (this.rpcAvailable) {
      lines.push(COPY.preview.help);
    } else {
      lines.push(`${COPY.preview.runUnavailable}  [${KEY.save}] Save  [${KEY.scopeUser}/${KEY.scopeProject}] scope  [${KEY.edit}] edit  [${KEY.add}] add  [${KEY.delete}] delete  [${KEY.escape}] cancel`);
    }
    return lines;
  }

  private renderEditPick(width: number, mode: Extract<PreviewMode, { kind: "edit-pick" }>): string[] {
    const lines: string[] = [];
    const bar = BAR(width);
    lines.push(COPY.preview.editPickTitle(mode.phaseIndex));
    const targets = this.targetsFor(mode.phaseIndex);
    for (const [i, t] of targets.entries()) {
      const mark = i === mode.pick ? "\u25b6" : " ";
      lines.push(`${mark} ${this.targetLabel(t)}`);
    }
    if (this.hasGate()) lines.push(COPY.preview.gateReadOnly);
    lines.push(bar);
    lines.push(COPY.preview.editPickHelp);
    return lines;
  }

  private renderEditText(width: number, mode: Extract<PreviewMode, { kind: "edit-text" }>): string[] {
    const lines: string[] = [];
    lines.push(this.targetPrompt(mode.target));
    lines.push(`> ${mode.entry.line()}`);
    if (mode.error) lines.push(`! ${mode.error}`);
    lines.push(COPY.preview.editHelp);
    return lines;
  }

  private renderAdd(width: number, mode: Extract<PreviewMode, { kind: "add" }>): string[] {
    const lines: string[] = [];
    const bar = BAR(width);
    lines.push(COPY.preview.addTitle);
    lines.push(mode.stage === "agent" ? COPY.preview.addAgentPrompt : COPY.preview.addTaskPrompt);
    lines.push(`> ${mode.entry.line()}`);
    if (mode.error) lines.push(`! ${mode.error}`);
    lines.push(bar);
    lines.push(COPY.preview.addComments);
    return lines;
  }

  private renderConfirmDelete(width: number, mode: Extract<PreviewMode, { kind: "confirm-delete" }>): string[] {
    const lines = this.baseLines(width);
    const bar = BAR(width);
    lines.push(bar);
    if (this.error) lines.push(`! ${this.error}`);
    lines.push(COPY.preview.deleteConfirm(mode.phaseIndex));
    return lines;
  }
}