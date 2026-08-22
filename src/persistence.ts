/**
 * Workflow definition persistence: atomic save/load, name validation,
 * project > user precedence, and the registry JSON.
 */
import fs from "node:fs";
import path from "node:path";
import {
  MAX_WORKFLOW_NAME_LEN,
  RESERVED_PI_NAMES,
  USER_WORKFLOWS_DIR,
  WORKFLOW_REGISTRY_FILE,
} from "./constants.ts";
import { type WorkflowIR, validate } from "./ir.ts";

export interface WorkflowDef {
  name: string;
  description?: string;
  ir: WorkflowIR;
  scope: "user" | "project";
  /** Resolved absolute path of the .json file. */
  path: string;
  /** ISO 8601 */
  savedAt: string;
}

export interface RegistryEntry {
  name: string;
  scope: "user" | "project";
  path: string;
  savedAt: string;
  deleted?: true;
}

export type SaveResult =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; reason: "name_invalid"; detail: string }
  | { ok: false; reason: "name_collision"; collidesWith: "workflow"; existing: string }
  | { ok: false; reason: "io_error"; detail: string };

export function resolveWorkflowPath(name: string, scope: "user" | "project", cwd: string): string {
  const filename = `${name}.json`;
  if (scope === "user") {
    return path.join(USER_WORKFLOWS_DIR, filename);
  }
  return path.join(cwd, ".pi", "workflows", filename);
}

/** Atomic write: <path>.tmp then rename; keep <path>.bak sidecar for recovery. */
export function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch {
    // best-effort backup: recovery path is optional, the primary write already succeeded
  }
}

export function readJsonWithBackup<T>(filePath: string): T | undefined {
  const tryRead = (p: string): T | undefined => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as T;
    } catch {
      return undefined;
    }
  };
  const parsed = tryRead(filePath);
  if (parsed !== undefined) return parsed;
  return tryRead(`${filePath}.bak`);
}

export function validateWorkflowName(name: string): { ok: true } | { ok: false; reason: string } {
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, reason: "name must not be empty" };
  }
  const trimmed = name.trim();
  if (name !== trimmed) {
    return { ok: false, reason: "name must not have leading/trailing whitespace" };
  }
  if (name.length > MAX_WORKFLOW_NAME_LEN) {
    return { ok: false, reason: `name must be at most ${MAX_WORKFLOW_NAME_LEN} characters` };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { ok: false, reason: "name must match [a-zA-Z0-9_-]+" };
  }
  if (RESERVED_PI_NAMES.has(name)) {
    return { ok: false, reason: `name "${name}" is reserved by Pi; choose another` };
  }
  if (name === "." || name === "..") {
    return { ok: false, reason: `name must not be "." or ".."` };
  }
  return { ok: true };
}

/**
 * Save a workflow definition. Writes the IR file atomically and returns the
 * registry entry to append. Registry persistence is the caller's job.
 * Builtin/skill collisions are checked by WorkflowRegistry (which knows Pi's
 * commands); this function only detects workflow-name collisions.
 */
export function saveWorkflow(def: WorkflowDef, registry: RegistryEntry[]): SaveResult {
  const nameCheck = validateWorkflowName(def.name);
  if (!nameCheck.ok) {
    return { ok: false, reason: "name_invalid", detail: nameCheck.reason };
  }
  const existing = registry.find((e) => e.name === def.name && !e.deleted);
  if (existing && existing.path !== def.path) {
    return { ok: false, reason: "name_collision", collidesWith: "workflow", existing: def.name };
  }
  const entry: RegistryEntry = {
    name: def.name,
    scope: def.scope,
    path: def.path,
    savedAt: def.savedAt,
  };
  try {
    atomicWriteJson(def.path, {
      name: def.name,
      description: def.description,
      scope: def.scope,
      savedAt: def.savedAt,
      ir: def.ir,
    });
  } catch (err) {
    return { ok: false, reason: "io_error", detail: String(err) };
  }
  return { ok: true, entry };
}

/** Project > user: project-local `.pi/workflows/<name>.json` wins over the user dir. */
export function loadWorkflow(name: string, cwd: string): WorkflowDef | undefined {
  const candidates = [
    { scope: "project" as const, path: resolveWorkflowPath(name, "project", cwd) },
    { scope: "user" as const, path: resolveWorkflowPath(name, "user", cwd) },
  ];
  for (const c of candidates) {
    const maybe = readJsonWithBackup<{
      name?: unknown;
      description?: unknown;
      scope?: unknown;
      savedAt?: unknown;
      ir: unknown;
    }>(c.path);
    if (maybe === undefined || typeof maybe !== "object") continue;
    if (maybe.ir === undefined) continue;
    if (maybe.name !== name) continue;
    const res = validate(maybe.ir);
    if (!res.ok) continue;
    return {
      name: name,
      description: typeof maybe.description === "string" ? maybe.description : res.ir.description,
      ir: res.ir,
      scope: maybe.scope === "project" ? "project" : "user",
      path: c.path,
      savedAt: typeof maybe.savedAt === "string" ? maybe.savedAt : new Date().toISOString(),
    };
  }
  return undefined;
}

export interface RegistryFile {
  version: number;
  entries: RegistryEntry[];
}

/** Registry is the source of truth for registered workflows. */
export function loadRegistry(): RegistryEntry[] {
  const file = readJsonWithBackup<RegistryFile>(WORKFLOW_REGISTRY_FILE);
  if (!file || typeof file !== "object" || !Array.isArray(file.entries)) return [];
  return file.entries.filter((entry): entry is RegistryEntry => {
    if (!entry || typeof entry !== "object") return false;
    return typeof entry.name === "string" && (entry.scope === "user" || entry.scope === "project") &&
      typeof entry.path === "string" && typeof entry.savedAt === "string" &&
      (entry.deleted === undefined || typeof entry.deleted === "boolean");
  });
}

/** Atomic registry write; soft-deleted entries are pruned on write. */
export function saveRegistry(entries: RegistryEntry[]): void {
  atomicWriteJson(WORKFLOW_REGISTRY_FILE, {
    version: 1,
    entries: entries.filter((e) => !e.deleted),
  });
}

/** Mark a workflow as soft-deleted (removed from registry on next write). */
export function softDeleteWorkflow(name: string, registry: RegistryEntry[]): boolean {
  const entry = registry.find((e) => e.name === name && !e.deleted);
  if (!entry) return false;
  entry.deleted = true;
  return true;
}