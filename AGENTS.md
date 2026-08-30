# AGENTS.md — Operational Invariants

Source-of-truth for what the code actually does, not what it might do someday.

## RPC v1 Bridge (`src/rpc-adapter.ts`)

Three channels, all prefixed `subagents:rpc:v1:`:

| Channel | Direction | Payload |
|---------|-----------|---------|
| `ready` | daemon → caller | `PingResult` (capabilities, session) |
| `request` | caller → daemon | `SubagentRpcRequestEnvelope` (version, requestId, method, params) |
| `reply` | daemon → caller | `SubagentRpcReplyEnvelope` (version, requestId, success/data/error) |

Replies are correlated by `requestId`. The adapter also subscribes to a per-request reply channel (`subagents:rpc:v1:reply:<requestId>`) alongside the generic reply channel for redundancy.

**Capability negotiation:** `detect()` listens for `ready`, then issues a `ping`. Availability is set only when the pong advertises version 1, methods `spawn` + `result`, and capabilities `asyncSpawn: true` + `result: true`. Without this exact contract, runs stay disabled — state goes to `unavailable`.

**Timeouts:** 10 s for detection, 10 s per RPC reply.

## spawn() Semantics

`spawn()` always sends `{ async: true }`. It never sends `action` or `clarify` — those params do not exist in the adapter interface. Every coordinator call site goes through `adapter.spawn()`.

## result() vs status()

These are distinct RPC methods with different roles:

- **`result(runId)`** — returns terminal output (`RpcResult`): state, output text, outputAvailable, outputTruncated, outcome. This is the only source of subagent output.
- **`status(runId)`** — returns lifecycle metadata (`StatusResult`): state, tokens, cost, steps. No output text.

`RunCoordinator.spawnAndPoll()` polls `result()` exclusively. `status()` is not used in the polling loop.

## Phase Engine (`src/run-coordinator.ts`, `src/ir.ts`)

The IR defines four phase types processed sequentially by `executePhases()`:

| Type | Behavior |
|------|----------|
| `sequential` | Steps run one at a time; any non-`complete` result stops the phase. |
| `parallel` | Steps run concurrently (chunked by `maxConcurrency`); all must complete. |
| `gate` | No RPC calls. Evaluates a condition (`success` on outputKey or `contains` on outputKey+pattern) and either advances or jumps to `skipToPhase`. Truncated output with `contains` is a hard failure. |
| `loop` | Steps run sequentially per round, repeating until an `until` condition is met or `maxRounds` is exhausted. `contains` on truncated output is indeterminate → fail. |

`maxAgents` (from IR limits or a constant ceiling) is a hard global cap across all phases. `pause()` is explicitly unimplemented — RPC v1 has no resume.

## Persistence & Registry (`src/persistence.ts`, `src/registry.ts`)

**Workflow loading:** project scope (`.pi/workflows/`) takes precedence over user scope (`~/.pi/agent/pi-workflows/saved/`). Files are read with a `.bak` sidecar fallback.

**Atomic writes:** `.tmp` then rename; optional `.bak` copy for recovery.

**Name validation:** `[a-zA-Z0-9_-]+`, max 128 chars, no whitespace, not `.` or `..`, not a reserved Pi name.

**Collision handling (two layers):**

1. `persistence.saveWorkflow()` — detects workflow-to-workflow name collisions within the registry (same name, different path → rejected).
2. `WorkflowRegistry.checkCollision()` — ordered check: reserved Pi name → skill/prompt command → registered workflow. Idempotent re-register (same scope+path) is allowed.

**Soft-delete:** marks `deleted: true` in registry; `saveRegistry()` prunes deleted entries on write.

## TUI Layer (`src/tui/`)

Four files. All are presentation-layer code that never performs mutations, but they do call downstream services directly for read-only display:

- **`run-drilldown.ts`** calls `adapter.result()` directly on a 2 s polling timer to fetch RPC output for display. It does not route through `RunCoordinator` — the adapter is the only dependency.
- **`browse-tui.ts`** calls `loadRegistry()` and `loadWorkflow()` from `src/persistence.ts` directly (not through `WorkflowRegistry`) when refreshing the saved/running/history lists. Stop actions route through `coordinator.stop()` (which the opener injects).
- **`preview-tui.ts`** is a pure IR viewer/editor. It does not call RPC methods or persistence directly.
- **`text.ts`** exports `TextEntry`, a mutable text-entry widget with cursor state (used by the create overlay and arg-entry overlay). It also ships `KEY` bindings and `COPY` strings. Not stateless.

No TUI file bypasses `RunCoordinator` or `RpcAdapter` for **mutations**. All RPC-gap states render truthfully (`[data unavailable]`).

## Timer & Listener Cleanup (`src/rpc-adapter.ts`)

`clearListeners()` (called on `reset()` and detection timeout) performs a full teardown:

1. Iterates the `pending` map — each entry gets its reply unsubscribe called, its timer cleared, and its promise rejected with `rpc_reset`.
2. Clears the `pending` map.
3. Unsubscribes the `readyUnsubscribe` listener.
4. Clears the `detectionTimer`.

`RpcAdapter.reset()` calls `clearListeners()` then restores state to `undetected` with null capabilities. No dangling timers or listeners survive a reset.
