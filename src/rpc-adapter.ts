/**
 * RpcAdapter: pi-subagents RPC v1 bridge via pi.events.
 *
 * // pi.events: EventBus (confirmed types.d.ts ExtensionAPI.events)
 *
 * Protocol (v1, defined by pi-subagents). Channels:
 *   subagents:rpc:v1:ready   → daemon announces it is listening (data: PingResult-shaped)
 *   subagents:rpc:v1:request → caller → daemon (SubagentRpcRequestEnvelope)
 *   subagents:rpc:v1:reply   → daemon → caller (matched by requestId)
 *
 * Methods: ping / spawn / status / interrupt / stop. spawn always carries
 * `{ async: true }` and never `action` or `clarify`.
 *
 * IMPORTANT: the installed pi-subagents (0.24.3, verified) does NOT emit the
 * `subagents:rpc:v1:ready` event — it exposes a single `subagent` tool and the
 * `subagent:async-*` / `subagent:control-event` channels only. The adapter
 * therefore deterministically lands in state "unavailable" after the detection
 * timeout, and run coordination is disabled cleanly (per plan constraint:
 * RPC unavailable disables runs). This file implements the v1 client so it is
 * ready the moment a pi-subagents build ships the protocol.
 */
import { randomUUID } from "node:crypto";

export const RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_REPLY_EVENT = "subagents:rpc:v1:reply";
export const rpcReplyEvent = (requestId: string) => `${RPC_REPLY_EVENT}:${requestId}`;

export const RPC_DETECTION_TIMEOUT_MS = 10_000;
export const RPC_REPLY_TIMEOUT_MS = 10_000;

/** EventBus interface mirroring pi.events (core/event-bus.d.ts). */
export interface EventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export type RpcAdapterState = "undetected" | "probing" | "available" | "unavailable";

export type SubagentRpcMethod = "ping" | "spawn" | "status" | "interrupt" | "stop";

export interface SubagentRpcRequestEnvelope {
  version: 1;
  requestId: string;
  method: SubagentRpcMethod;
  params?: unknown;
  source: { extension: "pi-workflows" };
}

export type SubagentRpcReplyEnvelope =
  | { version: 1; requestId: string; success: true; data: unknown }
  | { version: 1; requestId: string; success: false; error: { code: string; message: string } };

export interface PingResult {
  version: 1;
  methods: string[];
  capabilities: { status: boolean; asyncSpawn: boolean; interrupt: boolean; stop: boolean };
  session: { cwd: string; sessionId: string; sessionFile: string };
}

export interface SpawnResult {
  runId: string;
  asyncDir: string;
}

export type SubagentState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped";

export interface StatusResult {
  state: SubagentState;
  runId: string;
  sessionId: string;
  steps?: Array<{ status: string; tokens?: number; totalCost?: number }>;
  totalTokens?: number;
  totalCost?: number;
}

export interface StopResult {
  runId: string;
  asyncDir: string;
  previousState: string;
  state: "stopping";
}

export interface RpcError extends Error {
  code?: string;
}

export function makeRequest(method: SubagentRpcMethod, params?: unknown): SubagentRpcRequestEnvelope {
  return {
    version: 1,
    requestId: randomUUID(), // node:crypto, non-empty, no newlines
    method,
    params,
    source: { extension: "pi-workflows" },
  };
}

export class RpcAdapter {
  private _state: RpcAdapterState = "undetected";
  private _capabilities: PingResult["capabilities"] | null = null;
  private readonly events: EventBus;
  private readyUnsubscribe: (() => void) | null = null;
  private detectionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, { unsubscribe: () => void; timer: ReturnType<typeof setTimeout>; reject: (err: Error) => void }>();

  constructor(events: EventBus) {
    this.events = events;
  }

  get state(): RpcAdapterState {
    return this._state;
  }

  get capabilities(): PingResult["capabilities"] | null {
    return this._capabilities;
  }

  /** Listen for the ready event and ping to confirm v1. */
  detect(): void {
    if (this._state !== "undetected") return;
    this.readyUnsubscribe = this.events.on(RPC_READY_EVENT, (data) => {
      void this.handleReady(data);
    });
    this.detectionTimer = setTimeout(() => {
      if (this._state === "undetected") {
        this._state = "unavailable";
        this.clearListeners();
      }
    }, RPC_DETECTION_TIMEOUT_MS);
  }

  /** Reset state for next session. */
  reset(): void {
    this.clearListeners();
    this._state = "undetected";
    this._capabilities = null;
  }

  private clearListeners(): void {
    for (const [requestId, request] of this.pending) {
      request.unsubscribe();
      clearTimeout(request.timer);
      request.reject(Object.assign(new Error("RPC adapter reset"), { code: "rpc_reset", requestId }));
    }
    this.pending.clear();
    if (this.readyUnsubscribe) {
      this.readyUnsubscribe();
      this.readyUnsubscribe = null;
    }
    if (this.detectionTimer) {
      clearTimeout(this.detectionTimer);
      this.detectionTimer = null;
    }
  }

  private async handleReady(data: unknown): Promise<void> {
    if (this._state !== "undetected") return;
    this._state = "probing";
    try {
      const pong = await this.ping();
      if (pong.version === 1) {
        this._state = "available";
        this._capabilities = pong.capabilities;
      } else {
        this._state = "unavailable";
      }
    } catch {
      this._state = "unavailable";
    }
  }

  private ensureAvailable(): void {
    if (this._state !== "available") {
      throw Object.assign(new Error("pi-subagents RPC v1 unavailable"), { code: "rpc_unavailable" });
    }
  }

  private request<T>(method: SubagentRpcMethod, params?: unknown): Promise<T> {
    // ping is the probe itself: allowed from "probing" state while every
    // other method requires "available".
    if (this._state === "probing" && method === "ping") {
      // ok: probe in progress
    } else {
      this.ensureAvailable();
    }
    const envelope = makeRequest(method, params);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        const current = this.pending.get(envelope.requestId);
        if (current) {
          current.unsubscribe();
          clearTimeout(current.timer);
          this.pending.delete(envelope.requestId);
        }
        fn();
      };
      const onReply = (raw: unknown): void => {
        const reply = raw as Record<string, unknown>;
        if (!reply || reply.requestId !== envelope.requestId) return;
        if (reply.success === true || reply.ok === true) finish(() => resolve((reply.data ?? reply.result) as T));
        else if (reply.success === false || reply.ok === false) {
          const error = typeof reply.error === "string" ? reply.error : `${(reply.error as { code?: string })?.code ?? "rpc_error"}: ${(reply.error as { message?: string })?.message ?? "RPC request failed"}`;
          finish(() => reject(Object.assign(new Error(error), { code: "rpc_error" })));
        }
      };
      const unsubscribe = this.events.on(rpcReplyEvent(envelope.requestId), onReply);
      const legacyUnsubscribe = this.events.on(RPC_REPLY_EVENT, onReply);
      const timer = setTimeout(() => finish(() => reject(Object.assign(new Error(`RPC ${method} timed out after ${RPC_REPLY_TIMEOUT_MS}ms`), { code: "timeout" }))), RPC_REPLY_TIMEOUT_MS);
      this.pending.set(envelope.requestId, { unsubscribe: () => { unsubscribe(); legacyUnsubscribe(); }, timer, reject: (err) => finish(() => reject(err)) });
      this.events.emit(RPC_REQUEST_EVENT, envelope);
    });
  }

  ping(): Promise<PingResult> {
    return this.request<PingResult>("ping");
  }

  /** Spawn a subagent async run. async:true is mandatory; never action/clarify. */
  spawn(params: { agent: string; task: string; context: "fresh" | "fork"; cwd: string }): Promise<SpawnResult> {
    return this.request<SpawnResult>("spawn", {
      agent: params.agent,
      task: params.task,
      context: params.context,
      cwd: params.cwd,
      async: true,
    });
  }

  status(params: { runId?: string; id?: string; dir?: string }): Promise<StatusResult> {
    return this.request<StatusResult>("status", params);
  }

  interrupt(params: { runId?: string; id?: string }): Promise<void> {
    return this.request<void>("interrupt", params);
  }

  /** Stop only a running run; RPC rejects invalid_state otherwise. */
  stop(params: { runId: string }): Promise<StopResult> {
    return this.request<StopResult>("stop", params);
  }
}