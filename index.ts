/**
 * pi-workflows composition root.
 *
 * Wires extension lifecycle, command registration, directive interception,
 * run coordination, and the deferred authoring TUI. All execution composes
 * via pi-subagents RPC v1 through RpcAdapter; when RPC is unavailable runs
 * are disabled cleanly in the UI.
 */
import type { ExtensionAPI, InputEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RpcAdapter } from "./src/rpc-adapter.ts";
import { WorkflowRegistry } from "./src/registry.ts";
import { RunStore, createRun } from "./src/run-state.ts";
import { RunCoordinator } from "./src/run-coordinator.ts";
import {
  loadRegistry,
  loadWorkflow,
  saveWorkflow,
  saveRegistry,
  softDeleteWorkflow,
  resolveWorkflowPath,
  type WorkflowDef,
  type RegistryEntry,
} from "./src/persistence.ts";
import { buildIrSubmitTool, resetAuthoringState, beginAuthoring, consumeAuthoringDraft, authoringState, buildIRPrompt, scanAgents } from "./src/authoring.ts";
import { DirectiveQueue } from "./src/directive-queue.ts";
import { parseDirectives } from "./src/parser.ts";
import { WorkflowIRSchema } from "./src/ir.ts";
import { BrowseTui, type BrowseResult } from "./src/tui/browse-tui.ts";
import { PreviewTui, type PreviewResult } from "./src/tui/preview-tui.ts";

export default function piWorkflows(pi: ExtensionAPI) {
  const runStore = new RunStore();
  const directiveQueue = new DirectiveQueue();
  let registry = new WorkflowRegistry([]);
  let adapter: RpcAdapter | null = null;
  let coordinator: RunCoordinator | null = null;
  let handlerMap = new Map<string, (args: string) => Promise<void>>();
  // 1. _wf_ir_submit tool: model-only (custom tools are model-callable by
  // construction; ToolDefinition in 0.84.1 has no userInvocable flag).
  pi.registerTool(buildIrSubmitTool());

  // 2. session_start: init RPC adapter, register workflows from registry.
  pi.on("session_start", (_event, ctx) => {
    resetAuthoringState();
    directiveQueue.clear();
    runStore.clear();

    adapter = new RpcAdapter(pi.events); // pi.events: EventBus (confirmed types)
    adapter.detect();

    coordinator = new RunCoordinator({
      adapter,
      runStore,
      sendUserMessage: (text: string) => pi.sendUserMessage(text), // void; never used as value
      cwd: ctx.cwd,
    });

    const piCmds = pi.getCommands().map((c) => ({ name: c.name, source: c.source }));
    registry = new WorkflowRegistry(piCmds);

    handlerMap = new Map<string, (args: string) => Promise<void>>();
    for (const entry of loadRegistry().filter((e) => !e.deleted)) {
      const collision = registry.checkCollision(entry.name);
      if (collision.collision) {
        ctx.ui.notify(`pi-workflows: skipped /${entry.name} — collision with ${collision.kind}`, "warning");
        continue;
      }
      const def = loadWorkflow(entry.name, ctx.cwd);
      if (!def) continue;
      registry.register(entry.name, def);

      const handler = (args: string): Promise<void> =>
        runWorkflowByName(def.name, args, ctx.cwd, pi, runStore, adapter, coordinator, registry);
      handlerMap.set(entry.name, (args: string) => handler(args));
      pi.registerCommand(entry.name, {
        description: def.description ?? `Workflow: ${entry.name}`,
        handler: async (args, _ctx) => handler(args),
      });
    }
    directiveQueue.setHandlerMap(handlerMap);
  });

  // 3. /workflows main command.
  pi.registerCommand("workflows", {
    description: "Browse, create, run, and manage workflows",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("pi-workflows requires TUI mode", "warning");
        return;
      }
      const subcmd = args.trim().split(/\s+/)[0];
      if (subcmd === "create" || subcmd === "c") {
        await startWorkflowCreation(args.replace(/^create\s*/i, "").trim(), pi, ctx, adapter, authoringState);
        return;
      }
      if (subcmd === "review" || subcmd === "preview") {
        const draft = authoringState?.pendingDraft;
        if (draft) {
          await openPreviewTui(draft, pi, ctx, runStore, adapter, coordinator, registry);
        } else {
          ctx.ui.notify("pi-workflows: no pending draft; run /workflows create first", "info");
        }
        return;
      }
      const result = await ctx.ui.custom<BrowseResult>((_tui, _theme, _keys, done) => {
        const tui = new BrowseTui({
          done: (r: BrowseResult) => done(r),
          runStore,
          adapter: adapter ?? new RpcAdapter(pi.events),
          coordinator: coordinator ?? undefined,
          registry,
          cwd: ctx.cwd,
        });
        tui.wireInvalidate(() => {
          const render = (_tui as unknown as { requestRender?: () => void }).requestRender;
          render?.call(_tui);
        });
        return tui;
      });
      await handleBrowseResult(result, pi, ctx, runStore, adapter, coordinator, registry, handlerMap);
    },
  });

  // 4. input: directive interception (max 8; unknown /foo preserved as prose).
  pi.on("input", (event): InputEventResult => {
    if (event.source === "extension") return { action: "continue" }; // skip own/injected messages
    const workflowNames = new Set<string>(registry.names());
    const skillNames = new Set<string>(
      pi.getCommands().filter((c) => c.source === "skill").map((c) => c.name)
    );
    const knownNames = new Set([...workflowNames, ...skillNames]);
    const parsed = parseDirectives(event.text, knownNames);
    if (parsed.directiveCount === 0) return { action: "continue" };
    directiveQueue.enqueue(parsed.tokens, workflowNames, skillNames);
    directiveQueue.processNext((t) => pi.sendUserMessage(t));
    return { action: "handled" }; // Pi does not dispatch further
  });

  // 5. agent_end: advance directive queue + open deferred authoring TUI.
  pi.on("agent_end", (_event, ctx) => {
    if (directiveQueue.completeTurn()) directiveQueue.processNext((t) => pi.sendUserMessage(t));
    if (authoringState?.pendingDraft && ctx?.ui) {
      const draft = authoringState.pendingDraft;
      void openPreviewTui(draft, pi, ctx, runStore, adapter, coordinator, registry);
    }
  });

  pi.on("agent_settled", () => {
    if (directiveQueue.completeTurn()) directiveQueue.processNext((t) => pi.sendUserMessage(t));
  });

  // 6. session_shutdown: reset detachable state.
  pi.on("session_shutdown", () => {
    void coordinator?.shutdown();
    adapter?.reset();
    adapter = null;
    coordinator = null;
    directiveQueue.clear();
    resetAuthoringState();
  });
}

async function startWorkflowCreation(
  description: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  adapter: RpcAdapter | null,
  state: { description: string } | null
): Promise<void> {
  if (adapter && adapter.state !== "available") {
    ctx.ui.notify("pi-workflows: runs are disabled (pi-subagents RPC unavailable); you can still author and save", "info");
  }
  beginAuthoring(state?.description ?? description);
  const agents = scanAgents(); // reads ~/.pi/agent/agents/ (absent → empty + notice)
  const prompt = buildIRPrompt(description, agents, JSON.stringify(WorkflowIRSchema));
  // pi.sendUserMessage returns void; do not await or use its value.
  pi.sendUserMessage(prompt);
}

async function runWorkflowByName(
  name: string,
  args: string,
  cwd: string,
  pi: ExtensionAPI,
  runStore: RunStore,
  adapter: RpcAdapter | null,
  coordinator: RunCoordinator | null,
  registry: WorkflowRegistry
): Promise<void> {
  const current = registry.get(name);
  const def = current;
  if (!def) {
    pi.sendUserMessage(`[pi-workflows] workflow "${name}" deleted or not registered; run /reload to restore`);
    return;
  }
  await runWorkflow(def, pi, runStore, adapter, coordinator, parseWorkflowArgs(args));
}

async function runWorkflow(
  def: WorkflowDef,
  pi: ExtensionAPI,
  runStore: RunStore,
  adapter: RpcAdapter | null,
  coordinator: RunCoordinator | null,
  args: Record<string, unknown>
): Promise<void> {
  if (!coordinator || !adapter) {
    pi.sendUserMessage(`[pi-workflows] not initialized; run /reload`);
    return;
  }
  if (adapter.state !== "available") {
    pi.sendUserMessage(`[pi-workflows] /${def.name}: pi-subagents RPC unavailable; runs are disabled`);
    return;
  }
  const run = createRun(def.name, def.ir, args);
  runStore.add(run);
  await coordinator.run(run); // emits pi-workflows:run-result via sendUserMessage → agent_end
  runStore.remove(run.runId);
}

async function openPreviewTui(
  draft: WorkflowDef,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runStore: RunStore,
  adapter: RpcAdapter | null,
  coordinator: RunCoordinator | null,
  registry: WorkflowRegistry
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`pi-workflows: draft "${draft.name}" ready — run /workflows review in TUI mode`, "info");
    return;
  }
  try {
    const result: PreviewResult = await ctx.ui.custom<PreviewResult>((_tui, _theme, _keys, done) =>
      new PreviewTui(draft.ir, (r: PreviewResult) => done(r))
    );
    await handlePreviewResult(result, draft, pi, ctx, runStore, adapter, coordinator, registry);
    consumeAuthoringDraft();
  } catch {
    ctx.ui.notify("pi-workflows: could not open preview TUI; draft kept — run /workflows review", "warning");
  }
}

async function handlePreviewResult(
  result: PreviewResult,
  draft: WorkflowDef,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runStore: RunStore,
  adapter: RpcAdapter | null,
  coordinator: RunCoordinator | null,
  registry: WorkflowRegistry
): Promise<void> {
  if (result.action === "cancel") {
    ctx.ui.notify("pi-workflows: draft discarded", "info");
    return;
  }
  const def: WorkflowDef = {
    ...draft,
    ir: result.ir,
    scope: result.scope,
    path: resolveWorkflowPath(result.ir.name, result.scope, ctx.cwd),
    savedAt: new Date().toISOString(),
  };
  const collision = registry.checkCollision(def.name, { scope: def.scope, path: def.path });
  if (collision.collision) { ctx.ui.notify(`pi-workflows: name "${def.name}" collides with ${collision.kind}; not saved`, "warning"); return; }
  if (!persistWorkflow(def, ctx)) return;
  if (result.action === "run") {
    await runWorkflow(def, pi, runStore, adapter, coordinator, {});
  } else {
    ctx.ui.notify(`pi-workflows: "${def.name}" saved (${def.scope}) — run /reload to register`, "info");
  }
}

/** Persist a workflow: validate, write atomically, update registry file. */
function persistWorkflow(def: WorkflowDef, ctx: ExtensionContext): boolean {
  const registryEntries = loadRegistry();
  const res = saveWorkflow(def, registryEntries);
  if (!res.ok) {
    ctx.ui.notify(
      `pi-workflows: save failed (${res.reason}): ${"detail" in res ? res.detail : res.existing}`,
      "error"
    );
    return false;
  }
  saveRegistry(updateRegistryEntry(registryEntries, res.entry));
  return true;
}

function updateRegistryEntry(entries: RegistryEntry[], entry: RegistryEntry): RegistryEntry[] {
  return [...entries.filter((e) => e.name !== entry.name), entry];
}

async function handleBrowseResult(
  result: BrowseResult,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runStore: RunStore,
  adapter: RpcAdapter | null,
  coordinator: RunCoordinator | null,
  registry: WorkflowRegistry,
  handlerMap: Map<string, (args: string) => Promise<void>>
): Promise<void> {
  switch (result.action) {
    case "create":
      await startWorkflowCreation("", pi, ctx, adapter, null);
      break;
    case "run-workflow": {
      const def = registry.get(result.name);
      if (def) await runWorkflow(def, pi, runStore, adapter, coordinator, parseWorkflowArgs(result.args ?? ""));
      break;
    }
    case "save-workflow": {
      const def: WorkflowDef = {
        ...result.def,
        scope: result.scope,
        path: resolveWorkflowPath(result.def.name, result.scope, ctx.cwd),
        savedAt: new Date().toISOString(),
      };
      const collision = registry.checkCollision(def.name, { scope: def.scope, path: def.path });
      const samePath = loadWorkflow(def.name, ctx.cwd)?.path === def.path;
      if (collision.collision && !(collision.kind === "workflow" && samePath)) {
        ctx.ui.notify(`pi-workflows: name "${def.name}" collides with ${collision.kind}; not saved`, "warning");
        return;
      }
      if (persistWorkflow(def, ctx)) {
        ctx.ui.notify(`pi-workflows: "${def.name}" saved (${def.scope}) — run /reload to register`, "info");
      }
      break;
    }
    case "delete-workflow": {
      const entries = loadRegistry();
      registry.unregister(result.name);
      handlerMap.delete(result.name);
      if (softDeleteWorkflow(result.name, entries)) saveRegistry(entries);
      break;
    }
    case "stop-run":
      if (coordinator) await coordinator.stop(result.runId);
      break;
    case "restart": {
      const def = registry.get(result.defName);
      if (def) {
        const clone = JSON.parse(JSON.stringify(def)) as WorkflowDef;
        await runWorkflow(clone, pi, runStore, adapter, coordinator, { ...result.run.args });
      }
      break;
    }
    case "close":
      break;
  }
}

/** Parse `/name key=value positional...` into {{arg}} substitution args. */
export function parseWorkflowArgs(args: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let positional = 1;
  for (const tok of args.trim().split(/\s+/)) {
    if (!tok) continue;
    const eq = tok.indexOf("=");
    if (eq > 0 && /^[a-zA-Z0-9_]+$/.test(tok.slice(0, eq))) {
      const key = tok.slice(0, eq);
      const value = tok.slice(eq + 1);
      if (value === "true") out[key] = true;
      else if (value === "false") out[key] = false;
      else if (/^-?\d+(\.\d+)?$/.test(value)) out[key] = Number(value);
      else out[key] = value;
      continue;
    }
    out[`arg${positional++}`] = tok;
  }
  return out;
}