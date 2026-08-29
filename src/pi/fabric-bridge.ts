import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ExtensionUiRequest, RpcRecord } from './types.ts'

export const HEDDLEWORK_FABRIC_BRIDGE_WIDGET = 'heddlework.fabric.bridge.v1'
export const HEDDLEWORK_FABRIC_BRIDGE_PREFIX = '__heddlework_fabric_bridge_v1__:'

export interface FabricPeerCard {
  id: string
  label: string
  status: 'idle' | 'running'
  model?: string | undefined
  cwd?: string | undefined
  startedAt: number
  updatedAt: number
  pendingMessages: boolean
}

export type FabricBridgeRequest =
  | { action: 'peers'; requestId: string }
  | { action: 'prewalk'; requestId: string }
  | { action: 'await'; requestId: string; peer?: string | undefined }
  | { action: 'cancel'; requestId: string; targetId: string }

export type FabricBridgeEvent =
  | { version: 1; requestId: string; event: 'ready' }
  | { version: 1; requestId: string; event: 'started'; activity: 'prewalk' | 'await'; note: string }
  | { version: 1; requestId: string; event: 'progress'; activity: 'await'; note: string; waiting: Array<{ label: string; status: 'idle' | 'running' }> }
  | { version: 1; requestId: string; event: 'peers'; peers: FabricPeerCard[] }
  | { version: 1; requestId: string; event: 'settled'; activity: 'prewalk' | 'await' }
  | { version: 1; requestId: string; event: 'cancelled'; activity: 'await'; error: string }
  | { version: 1; requestId: string; event: 'error'; activity: 'peers' | 'prewalk' | 'await'; error: string }

export function encodeFabricBridgeRequest(request: FabricBridgeRequest): string {
  return `${HEDDLEWORK_FABRIC_BRIDGE_PREFIX}${JSON.stringify(request)}`
}

export function parseFabricBridgeEvent(record: RpcRecord): FabricBridgeEvent | undefined {
  if (!isBridgeWidget(record)) return undefined
  const line = record.widgetLines?.[0]
  if (!line) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.requestId !== 'string' || typeof value.event !== 'string') return undefined
  if (value.event === 'ready') return { version: 1, requestId: value.requestId, event: 'ready' }
  if (value.event === 'started' && (value.activity === 'prewalk' || value.activity === 'await') && typeof value.note === 'string') {
    return { version: 1, requestId: value.requestId, event: 'started', activity: value.activity, note: value.note }
  }
  if (value.event === 'progress' && value.activity === 'await' && typeof value.note === 'string' && Array.isArray(value.waiting)) {
    const waiting = value.waiting.flatMap((candidate) => isRecord(candidate) && typeof candidate.label === 'string' && (candidate.status === 'idle' || candidate.status === 'running')
      ? [{ label: candidate.label, status: candidate.status as 'idle' | 'running' }]
      : [])
    if (waiting.length !== value.waiting.length) return undefined
    return { version: 1, requestId: value.requestId, event: 'progress', activity: 'await', note: value.note, waiting }
  }
  if (value.event === 'peers' && Array.isArray(value.peers)) {
    const peers = value.peers.flatMap(readPeerCard)
    if (peers.length !== value.peers.length) return undefined
    return { version: 1, requestId: value.requestId, event: 'peers', peers }
  }
  if (value.event === 'settled' && (value.activity === 'prewalk' || value.activity === 'await')) {
    return { version: 1, requestId: value.requestId, event: 'settled', activity: value.activity }
  }
  if (value.event === 'cancelled' && value.activity === 'await' && typeof value.error === 'string') {
    return { version: 1, requestId: value.requestId, event: 'cancelled', activity: 'await', error: value.error }
  }
  if (value.event === 'error' && (value.activity === 'peers' || value.activity === 'prewalk' || value.activity === 'await') && typeof value.error === 'string') {
    return { version: 1, requestId: value.requestId, event: 'error', activity: value.activity, error: value.error }
  }
  return undefined
}

export function heddleworkFabricBridgePath(root = join(tmpdir(), 'heddlework')): string {
  const path = join(root, 'pi-fabric-bridge-v1.mjs')
  let current = ''
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    // The bridge is materialized lazily for packaged binaries.
  }
  if (current === HEDDLEWORK_FABRIC_BRIDGE_SOURCE) return path
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, HEDDLEWORK_FABRIC_BRIDGE_SOURCE, 'utf8')
  renameSync(temporary, path)
  return path
}

function isBridgeWidget(record: RpcRecord): record is ExtensionUiRequest & { method: 'setWidget' } {
  return record.type === 'extension_ui_request'
    && record.method === 'setWidget'
    && record.widgetKey === HEDDLEWORK_FABRIC_BRIDGE_WIDGET
    && Array.isArray(record.widgetLines)
}

function readPeerCard(value: unknown): FabricPeerCard[] {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.label !== 'string'
    || (value.status !== 'idle' && value.status !== 'running')
    || typeof value.startedAt !== 'number'
    || typeof value.updatedAt !== 'number'
    || typeof value.pendingMessages !== 'boolean') return []
  return [{
    id: value.id,
    label: value.label,
    status: value.status,
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    pendingMessages: value.pendingMessages,
  }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export const HEDDLEWORK_FABRIC_BRIDGE_SOURCE = String.raw`const WIDGET_KEY = "heddlework.fabric.bridge.v1";
const INPUT_PREFIX = "__heddlework_fabric_bridge_v1__:";
const PREWALK_EVENT = "pi-fabric:prewalk:request:v1";
const PEERS_EVENT = "pi-fabric:peers:cards:v1";
const AWAIT_EVENT = "pi-fabric:peer:await-settle:v1";

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function claimable(pi, event, payload) {
  let claimed = false;
  let settled = false;
  let resolveResult = () => {};
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const request = {
    version: 1,
    ...payload,
    claim() {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    respond(response) {
      if (settled) return;
      settled = true;
      resolveResult(response);
    },
  };
  pi.events.emit(event, request);
  return claimed ? result : undefined;
}

export default function heddleworkFabricBridge(pi) {
  const waits = new Map();
  const publish = (ctx, payload) => {
    ctx.ui.setWidget(WIDGET_KEY, [JSON.stringify({ version: 1, ...payload })]);
  };

  const peers = async (request, ctx) => {
    const result = claimable(pi, PEERS_EVENT, { context: ctx });
    if (!result) {
      publish(ctx, { requestId: request.requestId, event: "error", activity: "peers", error: "Pi Fabric peer projection is unavailable" });
      return;
    }
    try {
      const response = await result;
      if (response && response.ok) publish(ctx, { requestId: request.requestId, event: "peers", peers: response.cards });
      else publish(ctx, { requestId: request.requestId, event: "error", activity: "peers", error: response?.error || "Pi Fabric peer projection failed" });
    } catch (error) {
      publish(ctx, { requestId: request.requestId, event: "error", activity: "peers", error: errorText(error) });
    }
  };

  const prewalk = async (request, ctx) => {
    const result = claimable(pi, PREWALK_EVENT, { context: ctx });
    if (!result) {
      publish(ctx, { requestId: request.requestId, event: "error", activity: "prewalk", error: "Pi Fabric prewalk is unavailable" });
      return;
    }
    publish(ctx, { requestId: request.requestId, event: "started", activity: "prewalk", note: "arming Fabric prewalk" });
    try {
      const response = await result;
      if (response && response.ok) publish(ctx, { requestId: request.requestId, event: "settled", activity: "prewalk" });
      else publish(ctx, { requestId: request.requestId, event: "error", activity: "prewalk", error: response?.error || "Pi Fabric prewalk failed" });
    } catch (error) {
      publish(ctx, { requestId: request.requestId, event: "error", activity: "prewalk", error: errorText(error) });
    }
  };

  const awaitPeers = async (request, ctx) => {
    const controller = new AbortController();
    const wait = { controller, cancelled: false };
    waits.set(request.requestId, wait);
    const update = (progress) => {
      if (wait.cancelled) return;
      const waiting = Array.isArray(progress?.waiting) ? progress.waiting : [];
      const note = waiting.length === 0
        ? "peers settling"
        : "waiting for " + waiting.map((peer) => peer.label + " (" + peer.status + ")").join(", ");
      publish(ctx, { requestId: request.requestId, event: "progress", activity: "await", note, waiting });
    };
    const result = claimable(pi, AWAIT_EVENT, {
      context: ctx,
      ...(request.peer ? { selector: request.peer } : {}),
      signal: controller.signal,
      update,
    });
    if (!result) {
      waits.delete(request.requestId);
      publish(ctx, { requestId: request.requestId, event: "error", activity: "await", error: "Pi Fabric peer settle gates are unavailable" });
      return;
    }
    publish(ctx, {
      requestId: request.requestId,
      event: "started",
      activity: "await",
      note: request.peer ? "waiting for " + request.peer + " to settle" : "waiting for peers to settle",
    });
    try {
      const response = await result;
      if (wait.cancelled) return;
      if (response && response.ok) publish(ctx, { requestId: request.requestId, event: "settled", activity: "await" });
      else publish(ctx, { requestId: request.requestId, event: "error", activity: "await", error: response?.error || "Pi Fabric peer settle gate failed" });
    } catch (error) {
      if (!wait.cancelled) publish(ctx, { requestId: request.requestId, event: "error", activity: "await", error: errorText(error) });
    } finally {
      waits.delete(request.requestId);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    publish(ctx, { requestId: "bridge", event: "ready" });
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "rpc" || !event.text.startsWith(INPUT_PREFIX)) return { action: "continue" };
    let request;
    try {
      request = JSON.parse(event.text.slice(INPUT_PREFIX.length));
    } catch (error) {
      publish(ctx, { requestId: "invalid", event: "error", activity: "peers", error: errorText(error) });
      return { action: "handled" };
    }
    if (!request || typeof request.requestId !== "string") return { action: "handled" };
    if (request.action === "peers") void peers(request, ctx);
    else if (request.action === "prewalk") void prewalk(request, ctx);
    else if (request.action === "await") void awaitPeers(request, ctx);
    else if (request.action === "cancel" && typeof request.targetId === "string") {
      const wait = waits.get(request.targetId);
      if (wait) {
        wait.cancelled = true;
        wait.controller.abort();
        waits.delete(request.targetId);
        publish(ctx, { requestId: request.targetId, event: "cancelled", activity: "await", error: "Peer settle gate cancelled" });
      }
    }
    return { action: "handled" };
  });

  pi.on("session_shutdown", () => {
    for (const wait of waits.values()) wait.controller.abort();
    waits.clear();
  });
}
`
