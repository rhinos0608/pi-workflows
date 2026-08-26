/**
 * Authoring: IR generation prompt, _wf_ir_submit model tool, authoring state.
 *
 * Flow: `/workflows create <desc>` → startWorkflowCreation sends buildIRPrompt
 * via sendUserMessage → model calls _wf_ir_submit with the IR JSON → tool
 * validates and stores the draft in authoringState → agent_end fires →
 * composition root opens PreviewTui via ctx.ui.custom (deferred — never open
 * a TUI from inside tool execute, which is unverified in Pi 0.84.1).
 */
import fs from "node:fs";
import path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validate, type WorkflowIR } from "./ir.ts";
import { SUBAGENTS_AGENTS_DIR } from "./constants.ts";
import { resolveWorkflowPath, type WorkflowDef } from "./persistence.ts";

export const WF_IR_SUBMIT_TOOL_NAME = "_wf_ir_submit";

const IrSubmitParams = Type.Object({
  ir: Type.Unknown(),
});

export interface AuthoringState {
  pending: boolean;
  /** Set by _wf_ir_submit; consumed by the agent_end handler. */
  pendingDraft: WorkflowDef | null;
  description: string;
}

export let authoringState: AuthoringState | null = null;

export function resetAuthoringState(): void {
  authoringState = null;
}

/** Begin a creation flow: pending, no draft yet, description captured. */
export function beginAuthoring(description: string): void {
  authoringState = { pending: true, pendingDraft: null, description };
}

/** Called by the _wf_ir_submit tool when a validated draft is ready. */
export function storeAuthoringDraft(def: WorkflowDef): void {
  authoringState = {
    pending: true,
    pendingDraft: def,
    description: authoringState?.description ?? "",
  };
}

/** Consume the pending draft (agent_end opened the TUI); keeps description. */
export function consumeAuthoringDraft(): void {
  if (!authoringState) return;
  authoringState = { ...authoringState, pending: false, pendingDraft: null };
}

function makeDraft(ir: WorkflowIR, cwd: string): WorkflowDef {
  const savedAt = new Date().toISOString();
  return {
    name: ir.name,
    description: ir.description,
    ir,
    scope: "user",
    path: resolveWorkflowPath(ir.name, "user", cwd),
    savedAt,
  };
}

/**
 * Build the IR-submit tool. Model-only: registered via pi.registerTool; the
 * draft is stored (never executed) and the preview TUI opens after agent_end.
 */
export function buildIrSubmitTool(): ReturnType<typeof defineTool> {
  const tool: ToolDefinition<typeof IrSubmitParams> = {
    name: WF_IR_SUBMIT_TOOL_NAME,
    label: "Workflow IR Submit",
    description:
      "Validate and store a pi-workflows workflow definition (declarative JSON IR, version 1). " +
      "Called by the agent when generating a workflow draft. Returns validation errors or " +
      "confirmation that the preview will open after this turn.",
    parameters: IrSubmitParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = validate(params.ir);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Validation errors:\n${result.errors.join("\n")}` }],
          details: {},
        };
      }
      storeAuthoringDraft(makeDraft(result.ir, ctx.cwd));
      return {
        content: [{ type: "text", text: "Draft ready. Preview will open after this turn." }],
        details: {},
      };
    },
  };
  return defineTool(tool);
}

/**
 * Construct the IR generation prompt. Pure and testable. Output is data, not
 * instructions: the model must produce JSON that validate() accepts.
 */
export function buildIRPrompt(description: string, availableAgents: string[], irSchemaJson: string): string {
  const agents = availableAgents.length > 0 ? availableAgents.join(", ") : "(agent autocomplete unavailable — leave agent fields as plain names)";
  return [
    "You are generating a Pi workflow definition. Output ONLY valid JSON conforming to the schema below.",
    "Do NOT wrap in markdown. The output will be passed directly to the _wf_ir_submit tool.",
    "",
    `Available agents: ${agents}`,
    `Schema: ${irSchemaJson}`,
    "",
    "Hard limits:",
    "- phases: at least 1, sequential top-to-bottom",
    "- loop maxRounds: required, 1-50",
    "- gate skipToPhase: valid 0-based phase index",
    "- limits.maxRounds default 10 max 50; limits.maxAgents default 8 max 32",
    "- No JavaScript, no template execution. {{arg_name}} = simple string substitution only.",
    "- name must match [a-zA-Z0-9_-]+, ≤128 chars",
    "- contains gates use literal, case-sensitive terminal output text; regex and evaluation are forbidden",
    "",
    `Request: ${description}`,
  ].join("\n");
}

/** Scan pi-subagents agent registry dir for available agent names. */
export function scanAgents(): string[] {
  try {
    const entries = fs.readdirSync(SUBAGENTS_AGENTS_DIR, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isFile() && /\.(md|yaml|yml)$/i.test(e.name))
      .map((e) => path.basename(e.name).replace(/\.(md|yaml|yml)$/i, ""));
    return names;
  } catch {
    return []; // directory absent → empty list; prompt carries the notice
  }
}