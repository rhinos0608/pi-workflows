/**
 * Central copy + key data for the Browse / Preview / Drilldown TUIs.
 * Every user-visible string and key binding lives here so the TUIs stay
 * in sync and keyboard-visible. Data-only module — no rendering framework,
 * no state, no pi-tui imports. Also ships the tiny inline text entry used
 * by the create overlay and the preview editors.
 */

export const KEY = {
  moveUp: "k",
  moveDown: "j",
  upArrow: "up",
  downArrow: "down",
  confirm: "\r",
  escape: "\u001b",
  quit: "q",
  tabSaved: "1",
  tabRunning: "2",
  tabHistory: "3",
  run: "r",
  save: "s",
  stop: "s",
  restart: "R",
  delete: "d",
  create: "c",
  open: "\r",
  edit: "e",
  add: "a",
  reorderUp: "K",
  reorderDown: "J",
  scopeUser: "u",
  scopeProject: "p",
  yes: "y",
  no: "n",
  backspace: "\u007f",
  left: "left",
  right: "right",
} as const;

/** Keys that map to the same movement, in handleInput match order. */
export const MOVE_DOWN = [KEY.moveDown, KEY.downArrow] as const;
export const MOVE_UP = [KEY.moveUp, KEY.upArrow] as const;

/** Single-key printable input guard: exactly one char, not control. */
export function isPrintable(data: string): boolean {
  return data.length === 1 && data >= " ";
}

/** Small inline text entry with cursor (used by create overlay + editors). */
export class TextEntry {
  value: string;
  cursor: number;
  constructor(initial = "") {
    this.value = initial;
    this.cursor = initial.length;
  }
  insert(ch: string): void {
    if (ch.length !== 1) return;
    this.value = this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor);
    this.cursor++;
  }
  backspace(): void {
    if (this.cursor === 0) return;
    this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
    this.cursor--;
  }
  left(): void { this.cursor = Math.max(0, this.cursor - 1); }
  right(): void { this.cursor = Math.min(this.value.length, this.cursor + 1); }
  set(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }
  /** Render "> value▍" with the cursor block in place. */
  line(): string {
    return `${this.value.slice(0, this.cursor)}\u258d${this.value.slice(this.cursor)}`;
  }
}

const trunc = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}\u2026`);

export const COPY = {
  browse: {
    rpcNote: "(pi-subagents unavailable \u2014 Run controls disabled)",
    tabs: (saved: number, running: number, history: number) =>
      `[${KEY.tabSaved}] Saved (${saved})   [${KEY.tabRunning}] Running (${running})   [${KEY.tabHistory}] History (${history})`,
    emptySaved: () => `(no saved workflows \u2014 press ${KEY.create} to create)`,
    emptyRunning: "(no active runs)",
    emptyHistory: "(no run history)",
    loadError: "[load error]",
    dataUnavailable: "[data unavailable]",
    note: (text: string) => `note: ${text}`,
    error: (text: string) => `error: ${text}`,
    deleteConfirm: (name: string) => `Delete "${name}"? [y/n]`,
    argEntry: (line: string) => `Arguments: ${line} (Enter to run, Esc to cancel)`,
    argEntryEmptyError: "arguments empty \u2014 press Enter to run with none, or Esc to cancel",
    createTitle: "Create workflow",
    createPrompt: "Describe what it should do",
    createInput: (line: string) => `> ${line}`,
    createHelp: `[${KEY.confirm}] Generate  [${KEY.escape}] cancel`,
    createEmptyError: "workflow description must not be empty",
    runDisabled: "runs are disabled (pi-subagents unavailable)",
    runNote: (name: string) => `Loading \u2014 press ${KEY.escape} to cancel, ${KEY.confirm} to run with no args`,
    stopFailed: "stop failed",
    stopUnavailable: "stop unavailable (no stop capability from pi-subagents)",
    deleteDone: (name: string) => `"${name}" deleted`,
    previewCancelled: "preview cancelled",
    footerAvailable: `[1/2/3] tabs  [${KEY.moveUp}/${KEY.moveDown}] move  [${KEY.open}] open  [${KEY.run}] run  [${KEY.stop}] stop  [${KEY.restart}] restart  [${KEY.delete}] delete  [${KEY.create}] create  [${KEY.quit}] quit`,
    footerRpcOff: `[1/2/3] tabs  [${KEY.moveUp}/${KEY.moveDown}] move  [${KEY.open}] open  [${KEY.run}] run (disabled: pi-subagents unavailable)  [${KEY.restart}] restart  [${KEY.delete}] delete  [${KEY.create}] create  [${KEY.quit}] quit`,
  },
  preview: {
    title: (name: string, version: number) => `Preview: ${name} (v${version})`,
    scope: (scope: "user" | "project") =>
      scope === "user"
        ? "Scope: user (~/.pi/agent/pi-workflows/saved/)"
        : "Scope: project (.pi/workflows/)",
    scopeHelp: `[${KEY.scopeUser}/${KEY.scopeProject}] scope`,
    phaseType: (ph: { type: string }, steps?: number) =>
      steps !== undefined ? ` (steps: ${steps})` : "",
    gateReadOnly: "note: gate conditions are read-only \u2014 only the label is editable",
    help: `[${KEY.scopeUser}/${KEY.scopeProject}] scope  [${KEY.moveUp}/${KEY.moveDown}] select  [${KEY.edit}] edit  [${KEY.add}] add phase  [${KEY.delete}] delete  [${KEY.reorderUp}/${KEY.reorderDown}] reorder  [${KEY.run}] run  [${KEY.save}] save  [${KEY.escape}] cancel`,
    runUnavailable: `[${KEY.run}] Run unavailable (pi-subagents RPC off)`,
    runUnavailableNote: "run unavailable: pi-subagents RPC is off; save still works",
    editPickTitle: (i: number) => `Edit phase [${i}] \u2014 pick target:`,
    editPickLabel: (i: number) => `\u2500 phase label`,
    editPickStep: (i: number, field: "agent" | "task") => `\u2500 step ${i + 1} ${field}`,
    editPickHelp: `[${KEY.moveUp}/${KEY.moveDown}] move  [${KEY.open}] select  [${KEY.escape}] back`,
    editLabelPrompt: "label (Enter = keep/clear, Esc = cancel)",
    editAgentPrompt: "step agent (Enter = apply, Esc = cancel)",
    editTaskPrompt: "step task (Enter = apply, Esc = cancel)",
    editHelp: `[${KEY.open}] apply  [${KEY.escape}] cancel  [${KEY.left}/${KEY.right}] cursor`,
    stepAgentEmptyError: "step agent must not be empty",
    stepTaskEmptyError: "step task must not be empty",
    labelCleared: "(label cleared)",
    addTitle: "Add sequential phase",
    addAgentPrompt: "step agent (Enter to continue, Esc to cancel)",
    addTaskPrompt: "step task (Enter to insert, Esc to cancel)",
    addAgentEmptyError: "step agent must not be empty",
    addTaskEmptyError: "step task must not be empty",
    addComments: "note: new phases are appended after the selected phase; gates are not editable here",
    deleteConfirm: (i: number) => `Delete phase [${i}]? [y/n]`,
    deleteLastError: "cannot delete the last phase",
    deleteBlocked: (detail: string) => `delete blocked: ${detail}`,
  },
  drilldown: {
    header: (name: string, runId: string, status: string) =>
      `${trunc(name, 40)} | Run: ${runId} | Status: ${status}`,
    started: (iso: string, elapsed?: number) =>
      `Started ${iso}${elapsed !== undefined ? ` | elapsed ${(elapsed / 1000).toFixed(1)}s` : ""}`,
    tokens: (tokens: number) => `tokens: ${tokens}`,
    cost: (cost: number) => ` | cost: $${cost.toFixed(4)}`,
    error: (msg: string) => `error: ${msg}`,
    gateLine: (label: string) => `  condition: ${label}`,
    until: (label: string) => `  until: ${label}`,
    step: (i: number, agent: string, task: string) => `  ${i + 1}. ${agent} \u2014 ${trunc(task, 200)}`,
    dataUnavailable: "[data unavailable]",
    resultLine: (state: string) => `     state: ${state}`,
    output: (text: string) => `     output: ${text}`,
    noOutput: "[no output]",
    outputTruncated: "output truncated upstream",
    footer: `[${KEY.moveUp}/${KEY.moveDown}] phases  [${KEY.escape}] back`,
  },
} as const;

export const BAR = (width: number) => "\u2500".repeat(Math.max(8, width - 2));