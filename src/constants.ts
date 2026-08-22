/**
 * pi-workflows hard limits, reserved names, and environment-based paths.
 */
import path from "node:path";

export const MAX_ROUNDS_DEFAULT = 10;
export const MAX_ROUNDS_CEILING = 50;
export const MAX_AGENTS_DEFAULT = 8;
export const MAX_AGENTS_CEILING = 32;
export const MAX_DIRECTIVES = 8;
export const MAX_WORKFLOW_NAME_LEN = 128;

export const WORKFLOW_IR_ENTRY_TYPE = "pi-workflows:ir-draft";
export const WORKFLOW_RUN_ENTRY_TYPE = "pi-workflows:run";

/** Slash-command names owned by Pi that a workflow must never shadow. */
export const RESERVED_PI_NAMES = new Set<string>([
  "init", "memory", "config", "add-dir", "mcp", "permissions", "model", "new", "resume",
  "compact", "clear", "quit", "help", "reload", "pr", "review", "bug", "install", "update", "doctor",
  "workflows", "plan", "goal", // also block own command names
]);

export const PI_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? ".", ".pi", "agent");

export const WORKFLOW_CONFIG_DIR = path.join(PI_AGENT_DIR, "pi-workflows");
export const USER_WORKFLOWS_DIR = path.join(WORKFLOW_CONFIG_DIR, "saved");
export const WORKFLOW_RUNS_DIR = path.join(WORKFLOW_CONFIG_DIR, "runs");
export const WORKFLOW_REGISTRY_FILE = path.join(WORKFLOW_CONFIG_DIR, "registry.json");
export const MAX_RUN_HISTORY_DISK = 100;

/** pi-subagents agent registry directory (scan for available agent names). Absent → empty list. */
export const SUBAGENTS_AGENTS_DIR = path.join(PI_AGENT_DIR, "agents");