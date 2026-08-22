/**
 * Workflow IR: TypeBox schema + validate() with cross-field checks.
 *
 * The IR is declarative data only. It is never executed: steps are plain
 * { agent, task } descriptors consumed by the run coordinator, which composes
 * exclusively via pi-subagents RPC v1.
 *
 * Note: `contains` gates are allowed by the schema for forward compatibility,
 * but the run coordinator rejects them at runtime — RPC v1 `status` does not
 * expose agent text output, so there is no stable content source to evaluate
 * them against. Preserving the type keeps IR v1 stable for a future RPC
 * version that adds a stable output contract.
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { MAX_ROUNDS_CEILING, MAX_AGENTS_CEILING, MAX_ROUNDS_DEFAULT, MAX_AGENTS_DEFAULT } from "./constants.ts";

export const WORKFLOW_IR_VERSION = 1 as const;

const ArgDefSchema = Type.Object({
  type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]),
  required: Type.Optional(Type.Boolean()),
  default: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
  description: Type.Optional(Type.String({ maxLength: 200 })),
});

const StepSchema = Type.Object({
  agent: Type.String({ minLength: 1, maxLength: 256 }),
  task: Type.String({ minLength: 1, maxLength: 4000 }),
  outputKey: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9_]+$" })),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
});

const GateConditionSchema = Type.Union([
  Type.Object({ type: Type.Literal("success"), outputKey: Type.String({ minLength: 1 }) }),
  Type.Object({
    type: Type.Literal("contains"),
    outputKey: Type.String({ minLength: 1 }),
    pattern: Type.String({ minLength: 1 }),
  }),
]);

const LoopConditionSchema = Type.Union([
  Type.Object({ type: Type.Literal("success") }),
  Type.Object({
    type: Type.Literal("contains"),
    outputKey: Type.String({ minLength: 1 }),
    pattern: Type.String({ minLength: 1 }),
  }),
]);

const SequentialPhaseSchema = Type.Object({
  type: Type.Literal("sequential"),
  label: Type.Optional(Type.String({ maxLength: 200 })),
  steps: Type.Array(StepSchema, { minItems: 1 }),
});

const ParallelPhaseSchema = Type.Object({
  type: Type.Literal("parallel"),
  label: Type.Optional(Type.String({ maxLength: 200 })),
  steps: Type.Array(StepSchema, { minItems: 1 }),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
});

const GatePhaseSchema = Type.Object({
  type: Type.Literal("gate"),
  label: Type.Optional(Type.String({ maxLength: 200 })),
  condition: GateConditionSchema,
  skipToPhase: Type.Integer({ minimum: 0 }),
});

const LoopPhaseSchema = Type.Object({
  type: Type.Literal("loop"),
  label: Type.Optional(Type.String({ maxLength: 200 })),
  until: LoopConditionSchema,
  maxRounds: Type.Integer({ minimum: 1, maximum: MAX_ROUNDS_CEILING }),
  steps: Type.Array(StepSchema, { minItems: 1 }),
});

const PhaseSchema = Type.Union([SequentialPhaseSchema, ParallelPhaseSchema, GatePhaseSchema, LoopPhaseSchema]);

export const WorkflowIRSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" }),
  version: Type.Literal(1),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  args: Type.Optional(Type.Record(Type.String({ pattern: "^[a-zA-Z0-9_]+$" }), ArgDefSchema)),
  phases: Type.Array(PhaseSchema, { minItems: 1 }),
  limits: Type.Optional(
    Type.Object({
      maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ROUNDS_CEILING })),
      maxAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_AGENTS_CEILING })),
    })
  ),
});

export type WorkflowIR = Static<typeof WorkflowIRSchema>;
export type Phase = Static<typeof PhaseSchema>;
export type Step = Static<typeof StepSchema>;

export type ValidateResult =
  | { ok: true; ir: WorkflowIR }
  | { ok: false; errors: string[] };

/**
 * TypeBox check + post-schema cross-field checks:
 * - every gate skipToPhase index < phases.length
 * - no gate skipToPhase that points at the phase itself (would never progress)
 * - loop maxRounds within ceiling (schema enforces; double-checked)
 * - no duplicate outputKey within the same sequential/parallel phase
 */
export function validate(json: unknown): ValidateResult {
  if (typeof json !== "object" || json === null) {
    return { ok: false, errors: ["IR must be a JSON object"] };
  }
  if (!Value.Check(WorkflowIRSchema, json)) {
    const errors: string[] = [];
    for (const e of Value.Errors(WorkflowIRSchema, json)) {
      const p = (e as { path?: string }).path;
      errors.push(`${p && p !== "" ? p + ": " : ""}${e.message}`);
    }
    return { ok: false, errors };
  }
  const ir = json as WorkflowIR;

  const errors: string[] = [];
  const n = ir.phases.length;

  for (const [i, phase] of ir.phases.entries()) {
    if (phase.type === "gate") {
      if (phase.skipToPhase >= n) {
        errors.push(`phases[${i}] gate skipToPhase ${phase.skipToPhase} out of range (0..${n - 1})`);
      } else if (phase.skipToPhase === i) {
        errors.push(`phases[${i}] gate skipToPhase points at itself; workflow would never progress`);
      }
    }
    if (phase.type === "loop" && phase.maxRounds > MAX_ROUNDS_CEILING) {
      errors.push(`phases[${i}] loop maxRounds ${phase.maxRounds} exceeds ceiling ${MAX_ROUNDS_CEILING}`);
    }
    if (phase.type === "sequential" || phase.type === "parallel" || phase.type === "loop") {
      const seen = new Set<string>();
      for (const [k, step] of phase.steps.entries()) {
        if (step.outputKey !== undefined) {
          if (seen.has(step.outputKey)) {
            errors.push(`phases[${i}] duplicate outputKey "${step.outputKey}" at step ${k}`);
          }
          seen.add(step.outputKey);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, ir };
}

/** Defaults applied at use-time (never mutates the IR). */
export function effectiveMaxRounds(ir: WorkflowIR): number {
  return ir.limits?.maxRounds ?? MAX_ROUNDS_DEFAULT;
}

export function effectiveMaxAgents(ir: WorkflowIR): number {
  return ir.limits?.maxAgents ?? MAX_AGENTS_DEFAULT;
}