import { createConnection, type Socket } from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { attachJsonlReader, serializeJsonLine } from './jsonl.ts'
import type { AgentTransport, TransportStatus } from './transport.ts'
import type { PiMessage, RpcCommand, RpcRecord } from './types.ts'

export const HEDDLEWORK_LIVE_BRIDGE_VERSION = 1
export const HEDDLEWORK_LIVE_STATE_WIDGET = 'heddlework.live.state.v1'

export interface PiLiveSessionStateRecord extends RpcRecord {
  type: 'heddlework_session_state'
  state: Record<string, unknown>
  cwd: string
}

export function parsePiLiveSessionStateRecord(record: RpcRecord): PiLiveSessionStateRecord | undefined {
  if (record.type !== 'extension_ui_request' || record.method !== 'setWidget' || record.widgetKey !== HEDDLEWORK_LIVE_STATE_WIDGET) return undefined
  const line = Array.isArray(record.widgetLines) ? record.widgetLines[0] : undefined
  if (typeof line !== 'string') return undefined
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    if (candidate.type !== 'heddlework_session_state' || typeof candidate.cwd !== 'string' || !candidate.state || typeof candidate.state !== 'object' || Array.isArray(candidate.state)) return undefined
    return candidate as unknown as PiLiveSessionStateRecord
  } catch {
    return undefined
  }
}

export interface PiLiveBridgeAdvertisement {
  version: 1
  pid: number
  port: number
  token: string
  mode: 'tui' | 'rpc' | 'json' | 'print'
  cwd: string
  sessionFile?: string | undefined
  sessionId: string
  sessionName?: string | undefined
  model?: { provider?: string; id?: string } | undefined
  isStreaming?: boolean | undefined
  updatedAt: number
}

export function piLiveBridgeDirectory(environment: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): string {
  if (environment.HEDDLEWORK_RUNTIME_DIR) return join(environment.HEDDLEWORK_RUNTIME_DIR, 'pi-live')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'pi-live')
  if (platform === 'win32') return join(environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Heddlework', 'pi-live')
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'heddlework', 'pi-live')
}

export function discoverPiLiveBridges(root = piLiveBridgeDirectory()): PiLiveBridgeAdvertisement[] {
  if (!existsSync(root)) return []
  const bridges: PiLiveBridgeAdvertisement[] = []
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json')) continue
    const path = join(root, name)
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!isAdvertisement(value) || !processAlive(value.pid)) {
        rmSync(path, { force: true })
        continue
      }
      bridges.push(value)
    } catch {
      // Ignore partially written or concurrently removed registry entries.
    }
  }
  return bridges.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function heddleworkLiveBridgePath(root = join(piLiveBridgeDirectory(), 'extension')): string {
  const path = join(root, 'pi-live-bridge-v1.mjs')
  let current = ''
  try { current = readFileSync(path, 'utf8') } catch {}
  if (current === HEDDLEWORK_LIVE_BRIDGE_SOURCE) return path
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, HEDDLEWORK_LIVE_BRIDGE_SOURCE, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  return path
}

/** Install the bridge into Pi's user extension directory so ordinary TUI launches advertise themselves. */
export function ensureHeddleworkLiveBridgeInstalled(agentDir = resolvePiAgentDir()): string {
  const directory = join(agentDir, 'extensions')
  // Pi's automatic extension discovery loads direct .ts/.js files only.
  // Keep .mjs for explicit --extension materialization, but install .js here.
  const path = join(directory, 'heddlework-live-bridge.js')
  let current = ''
  try { current = readFileSync(path, 'utf8') } catch {}
  if (current === HEDDLEWORK_LIVE_BRIDGE_SOURCE) return path
  // Preserve existing permissions on a user-owned extensions directory; only new directories/files get private modes.
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, HEDDLEWORK_LIVE_BRIDGE_SOURCE, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  return path
}

export function resolvePiAgentDir(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = environment.PI_CODING_AGENT_DIR
  if (!configured) return join(home, '.pi', 'agent')
  return configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
}

export interface PiLiveBridgeTransportOptions {
  advertisement: PiLiveBridgeAdvertisement
  requestTimeoutMs?: number
  connectTimeoutMs?: number
  includeMessages?: boolean
  messageLimit?: number
}

export interface PiLiveSnapshotData {
  state: Record<string, unknown>
  cwd: string
  messages?: PiMessage[]
  assistant?: PiMessage
  tools: RpcRecord[]
  prompts?: RpcRecord[]
  sequence: number
}

export interface PiLiveSnapshotRecord extends PiLiveSnapshotData, RpcRecord {
  type: 'heddlework_live_snapshot'
}

export class PiLiveBridgeTransport implements AgentTransport {
  readonly ownership = 'attached' as const
  readonly #options: PiLiveBridgeTransportOptions
  readonly #eventListeners = new Set<(event: RpcRecord) => void>()
  readonly #statusListeners = new Set<(status: TransportStatus) => void>()
  readonly #pending = new Map<string, { resolve(value: RpcRecord): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  #socket: Socket | undefined
  #detachReader: (() => void) | undefined
  #requestId = 0
  #stderr = ''
  #snapshotReady = false
  #startupEvents: RpcRecord[] = []

  constructor(options: PiLiveBridgeTransportOptions) { this.#options = options }

  async start(): Promise<void> {
    if (this.#socket) throw new Error('Pi live bridge transport is already started')
    this.#emitStatus({ state: 'starting' })
    const socket = createConnection({ host: '127.0.0.1', port: this.#options.advertisement.port })
    this.#socket = socket
    this.#detachReader = attachJsonlReader(socket, (line) => this.#handleLine(line))
    socket.on('error', (error) => this.#disconnect(socket, error))
    socket.on('close', () => this.#disconnect(socket, new Error('Pi live bridge disconnected')))
    const connectTimeoutMs = this.#options.connectTimeoutMs ?? 5_000
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        socket.destroy()
        reject(new Error(`Timed out connecting to Pi live bridge after ${connectTimeoutMs}ms`))
      }, connectTimeoutMs)
      const cleanup = () => { clearTimeout(timer); socket.off('connect', onConnect); socket.off('error', onError); socket.off('close', onClose) }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const onConnect = () => { cleanup(); resolve() }
      const onClose = () => { cleanup(); reject(new Error('Pi live bridge connection closed during startup')) }
      socket.once('error', onError)
      socket.once('connect', onConnect)
      socket.once('close', onClose)
    })
    if (this.#socket !== socket) throw new Error('Pi live bridge disconnected during startup')
    socket.write(serializeJsonLine({ type: 'hello', token: this.#options.advertisement.token, version: 1 }))
    let snapshot: PiLiveSnapshotData
    try {
      snapshot = await this.request<PiLiveSnapshotData>({
        type: 'get_live_state',
        includeMessages: this.#options.includeMessages ?? false,
        messageLimit: Math.max(0, Math.min(200, this.#options.messageLimit ?? 40)),
      })
      this.#validateSnapshotIdentity(snapshot)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.#disconnect(socket, failure)
      throw failure
    }
    this.#snapshotReady = true
    this.#emitEvent({ type: 'heddlework_live_snapshot', ...snapshot })
    const buffered = this.#startupEvents
    this.#startupEvents = []
    for (const event of buffered) {
      const sequence = typeof event.sequence === 'number' ? event.sequence : undefined
      if (sequence !== undefined && sequence > snapshot.sequence) this.#emitEvent(event)
    }
    this.#emitStatus({ state: 'running', pid: this.#options.advertisement.pid })
  }

  async stop(): Promise<void> {
    const socket = this.#socket
    if (this.#socket === socket) this.#socket = undefined
    this.#detachReader?.()
    this.#detachReader = undefined
    this.#snapshotReady = false
    this.#startupEvents = []
    if (socket && !socket.destroyed) socket.destroy()
    this.#rejectPending(new Error('Pi live bridge transport stopped'))
    this.#emitStatus({ state: 'stopped' })
  }

  request<T = unknown>(command: RpcCommand): Promise<T> {
    const id = `live_${++this.#requestId}`
    const timeoutMs = this.#options.requestTimeoutMs ?? 45_000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Timed out waiting for Pi live command: ${command.type}`)) }, timeoutMs)
      this.#pending.set(id, { timer, resolve: (response) => response.success ? resolve(response.data as T) : reject(new Error(response.error ?? `Pi live command failed: ${command.type}`)), reject })
      try { this.send({ ...command, id }) } catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  send(record: RpcRecord): void {
    const socket = this.#socket
    if (!socket || socket.destroyed || !socket.writable) throw new Error('Pi live bridge is not connected')
    socket.write(serializeJsonLine(record))
  }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.#eventListeners.add(listener); return () => this.#eventListeners.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.#statusListeners.add(listener); return () => this.#statusListeners.delete(listener) }
  getStderr(): string { return this.#stderr }

  #handleLine(line: string): void {
    if (!line) return
    let record: RpcRecord
    try { record = JSON.parse(line) as RpcRecord } catch { this.#emitEvent({ type: 'transport_parse_error', line }); return }
    if (record.type === 'bridge_ready') return
    if (record.type === 'response' && record.id) {
      const pending = this.#pending.get(record.id)
      if (pending) { this.#pending.delete(record.id); clearTimeout(pending.timer); pending.resolve(record); return }
    }
    if (!this.#snapshotReady) this.#startupEvents.push(record)
    else this.#emitEvent(record)
  }
  #disconnect(socket: Socket, error: Error): void {
    if (this.#socket !== socket) return
    this.#socket = undefined
    this.#detachReader?.(); this.#detachReader = undefined
    this.#snapshotReady = false
    this.#startupEvents = []
    if (!socket.destroyed) socket.destroy()
    this.#stderr = error.message
    this.#rejectPending(error)
    this.#emitStatus({ state: 'exited', message: error.message })
  }
  #rejectPending(error: Error): void { for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error) }; this.#pending.clear() }
  #emitEvent(event: RpcRecord): void { for (const listener of this.#eventListeners) listener(event) }
  #emitStatus(status: TransportStatus): void { for (const listener of this.#statusListeners) listener(status) }
  #validateSnapshotIdentity(snapshot: PiLiveSnapshotData): void {
    const state = snapshot.state
    const sessionId = typeof state.sessionId === 'string' ? state.sessionId : undefined
    const sessionFile = typeof state.sessionFile === 'string' ? state.sessionFile : undefined
    const advertised = this.#options.advertisement
    if (advertised.sessionId && sessionId !== advertised.sessionId) throw new Error(`Pi live bridge owner changed session: expected ${advertised.sessionId}, got ${sessionId ?? 'none'}`)
    if (advertised.sessionFile && sessionFile !== advertised.sessionFile) throw new Error(`Pi live bridge owner changed session file: expected ${advertised.sessionFile}, got ${sessionFile ?? 'none'}`)
  }
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
function isAdvertisement(value: unknown): value is PiLiveBridgeAdvertisement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.version === 1 && typeof candidate.pid === 'number' && typeof candidate.port === 'number'
    && typeof candidate.token === 'string' && typeof candidate.cwd === 'string' && typeof candidate.sessionId === 'string'
    && typeof candidate.updatedAt === 'number' && (candidate.mode === 'tui' || candidate.mode === 'rpc' || candidate.mode === 'json' || candidate.mode === 'print')
}

export const HEDDLEWORK_LIVE_BRIDGE_SOURCE = String.raw`import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { StringDecoder } from "node:string_decoder";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = 1;
const KEY = Symbol.for("heddlework.pi.live.bridge.v1");
const STATE_WIDGET = "heddlework.live.state.v1";
const QUESTION_API = Symbol.for("heddlework.native.question.v1");
const QUESTION_CONTRACT = "heddlework.question.v1";
const DONT_KNOW_LABEL = "I don't know";
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const toolAls = new AsyncLocalStorage();
function newRequestId() { return randomBytes(16).toString("hex"); }

function registryRoot() {
  if (process.env.HEDDLEWORK_RUNTIME_DIR) return join(process.env.HEDDLEWORK_RUNTIME_DIR, "pi-live");
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Heddlework", "pi-live");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Heddlework", "pi-live");
  return join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "heddlework", "pi-live");
}

function errorText(error) { return error instanceof Error ? error.message : String(error); }
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => block && typeof block.text === "string" ? [block.text] : []).join("\n");
}

function persistedTimestamp(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function entryMessages(entry) {
  if (entry.type === "message" && entry.message) {
    const message = entry.message;
    if ((message.role === "user" || message.role === "assistant" || message.role === "toolResult") && message.content == null) {
      return [{ ...message, content: [] }];
    }
    return [message];
  }
  if (entry.type === "custom_message") {
    return [{
      role: "custom",
      customType: entry.customType,
      content: entry.content ?? [],
      display: entry.display,
      details: entry.details,
      timestamp: persistedTimestamp(entry.timestamp),
    }];
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: persistedTimestamp(entry.timestamp) }];
  }
  if (entry.type === "compaction") {
    return [{
      role: "compaction",
      content: entry.summary,
      display: true,
      tokensBefore: entry.tokensBefore,
      timestamp: persistedTimestamp(entry.timestamp),
    }];
  }
  return [];
}

function supportedThinking(model) {
  if (!model?.reasoning) return ["off"];
  return THINKING.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function branchMessages(ctx) {
  return ctx.sessionManager.buildContextEntries().flatMap(entryMessages);
}

function projectMessageUpdate(event) {
  const delta = event.assistantMessageEvent || {};
  let assistantMessageEvent;
  if (delta.type === "toolcall_start") {
    const toolCall = delta.partial?.content?.[delta.contentIndex];
    const { partial: _partial, ...rest } = delta;
    assistantMessageEvent = {
      ...rest,
      ...(toolCall?.type === "toolCall" && typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
      ...(toolCall?.type === "toolCall" && typeof toolCall.name === "string" ? { toolName: toolCall.name } : {}),
    };
  } else if (Object.prototype.hasOwnProperty.call(delta, "partial")) {
    const { partial: _partial, ...rest } = delta;
    assistantMessageEvent = rest;
  } else {
    assistantMessageEvent = delta;
  }
  return { type: "message_update", usage: event.message?.usage, assistantMessageEvent };
}

function forkMessages(ctx) {
  return ctx.sessionManager.getEntries()
    .flatMap((entry) => entry.type === "message" && entry.message?.role === "user"
      ? [{ entryId: entry.id, text: contentText(entry.message.content) }]
      : [])
    .filter((entry) => entry.text);
}

function stats(ctx) {
  let userMessages=0, assistantMessages=0, toolResults=0, totalMessages=0, toolCalls=0, cost=0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    totalMessages++;
    const message = entry.message;
    if (message.role === "user") userMessages++;
    else if (message.role === "toolResult") toolResults++;
    else if (message.role === "assistant") {
      assistantMessages++;
      if (Array.isArray(message.content)) toolCalls += message.content.filter((block) => block?.type === "toolCall").length;
      cost += message.usage?.cost?.total || 0;
    }
  }
  return { sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(), userMessages, assistantMessages, toolCalls, toolResults, totalMessages, cost, contextUsage: ctx.getContextUsage() };
}

function makeState(pi, ctx) {
  return {
    model: ctx.model ?? null,
    thinkingLevel: pi.getThinkingLevel(),
    isStreaming: !ctx.isIdle(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionId: ctx.sessionManager.getSessionId(),
    sessionName: pi.getSessionName(),
    pendingMessageCount: ctx.hasPendingMessages() ? 1 : 0,
    nativeQuestion: { contract: QUESTION_CONTRACT, dialogs: true, customQa: true },
  };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toolArgs(tool) {
  return asRecord(tool && tool.args);
}

function optionList(value) {
  if (!Array.isArray(value)) return [];
  const options = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      const label = entry.trim();
      if (seen.has(label)) continue;
      seen.add(label);
      options.push({ value: label, label });
      continue;
    }
    const option = asRecord(entry);
    const label = typeof option.label === "string" ? option.label.trim() : "";
    if (!label) continue;
    const optionValue = typeof option.value === "string" && option.value.trim() ? option.value.trim() : label;
    if (seen.has(optionValue)) continue;
    seen.add(optionValue);
    options.push({
      value: optionValue,
      label,
      ...(typeof option.description === "string" && option.description.trim() ? { description: option.description.trim() } : {}),
    });
  }
  return options;
}

function displayedOptionLabels(tool) {
  const details = asRecord(tool && (tool.details || asRecord(tool.partialResult).details));
  const update = asRecord(tool && tool.partialResult);
  const candidates = [details.options, asRecord(update.details).options];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const labels = candidate.flatMap((entry) => {
      if (typeof entry === "string" && entry.trim()) return [entry.trim()];
      const option = asRecord(entry);
      return typeof option.label === "string" && option.label.trim() ? [option.label.trim()] : [];
    });
    if (labels.length > 0) return labels;
  }
  return [];
}

function questionFromTool(tool) {
  if (!tool || tool.type === "tool_execution_end") return undefined;
  const args = toolArgs(tool);
  if (Array.isArray(args.questions)) return { variant: "tabbed", toolCallId: tool.toolCallId, stem: "" };
  const stem = typeof args.question === "string" ? args.question.trim() : "";
  if (!stem) return undefined;
  const authored = optionList(args.options);
  const displayed = displayedOptionLabels(tool);
  const remaining = [...authored];
  const options = displayed.length === 0 ? authored : displayed.map((label) => {
    const index = remaining.findIndex((option) => option.label === label);
    if (index < 0) return { value: label, label };
    return remaining.splice(index, 1)[0] || { value: label, label };
  });
  const graded = Object.prototype.hasOwnProperty.call(args, "correctAnswer") || Object.prototype.hasOwnProperty.call(args, "explanation");
  const description = typeof args.details === "string" && args.details.trim() ? args.details.trim() : undefined;
  const allowText = options.length === 0;
  const multiSelect = args.multiSelect === true;
  return {
    variant: "single",
    contract: QUESTION_CONTRACT,
    requestId: String(tool.toolCallId || ""),
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    stem,
    description,
    options,
    multiSelect,
    graded,
    allowCustom: !graded && !allowText,
    allowUnknown: graded,
    allowNote: graded,
    allowText,
    required: !allowText,
    kind: allowText ? "text" : multiSelect ? "multi-select" : "single-select",
    responseShape: graded ? "custom-quiz" : allowText ? "rpc-dialog" : "custom-ask",
  };
}

function runningQuestionTools(shared) {
  const found = [];
  for (const tool of shared.liveTools.values()) {
    const question = questionFromTool(tool);
    if (question && question.variant === "single") found.push({ tool, question });
  }
  return found;
}

function explicitQuestion(options) {
  if (!options || typeof options !== "object") return;
  const meta = options.question || options.nativeQuestion;
  if (meta && typeof meta === "object") return meta;
  if (options.contract === QUESTION_CONTRACT && (typeof options.stem === "string" || typeof options.question === "string")) return options;
}

function questionFromAls(shared, store) {
  if (!store || !store.toolCallId) return;
  const tool = shared.liveTools.get(store.toolCallId) || {
    type: "tool_execution_start",
    toolCallId: store.toolCallId,
    toolName: store.toolName,
    args: store.args,
  };
  return questionFromTool(tool);
}

function bindCustomQuestion(shared, options) {
  if (options && options.overlay === true && !explicitQuestion(options)) return;
  const explicit = explicitQuestion(options);
  if (explicit) {
    const requestId = String(explicit.requestId || newRequestId());
    const pending = shared.pendingQuestions.get(requestId);
    if (pending && pending.resolve) return;
    const toolCallId = explicit.toolCallId ? String(explicit.toolCallId) : undefined;
    if (toolCallId && shared.boundCustom.has(toolCallId)) return;
    return {
      requestId,
      toolCallId,
      question: { ...explicit, contract: QUESTION_CONTRACT, requestId, ...(toolCallId ? { toolCallId } : {}) },
    };
  }
  const fromAls = questionFromAls(shared, toolAls.getStore());
  if (toolAls.getStore()) {
    if (!fromAls || fromAls.variant !== "single") return;
    const toolCallId = String(fromAls.toolCallId || toolAls.getStore().toolCallId);
    if (shared.boundCustom.has(toolCallId)) return;
    const requestId = newRequestId();
    return { requestId, toolCallId, question: { ...fromAls, requestId, toolCallId } };
  }
  const running = runningQuestionTools(shared).filter((entry) => !shared.boundCustom.has(entry.tool.toolCallId));
  if (running.length !== 1) return;
  const toolCallId = running[0].tool.toolCallId;
  const requestId = newRequestId();
  return { requestId, toolCallId, question: { ...running[0].question, requestId, toolCallId } };
}

function wrapToolExecute(tool) {
  if (!tool || typeof tool.execute !== "function" || tool.execute.__hwAls) return;
  const original = tool.execute;
  function wrapped(toolCallId, params, signal, onUpdate, ctx) {
    return toolAls.run({ toolCallId, toolName: tool.name, args: params }, () => original.call(this, toolCallId, params, signal, onUpdate, ctx));
  }
  wrapped.__hwAls = true;
  tool.execute = wrapped;
}

function resultFromAnswer(question, answer) {
  if (!answer || answer.cancelled) return null;
  if (Object.prototype.hasOwnProperty.call(answer, "result")) return answer.result;
  return formatCustomResult(question, answer);
}

function quizAnswers(question, selected) {
  return selected.map((option, index) => ({
    label: option.label,
    value: option.value,
    index: (question.options.findIndex((candidate) => candidate.value === option.value) + 1) || index + 1,
  }));
}

function formatCustomResult(question, answer) {
  if (!answer || answer.cancelled) return null;
  const note = typeof answer.note === "string" && answer.note.trim() ? answer.note.trim() : undefined;
  if (question.allowText) {
    const text = String(answer.text || answer.custom || "").trim();
    return { type: "text", label: text, value: text };
  }
  if (question.graded) {
    if (answer.unknown) return { dontKnow: true, ...(note ? { note } : {}), answers: [] };
    const selected = (answer.selectedValues || []).flatMap((value) => {
      const option = question.options.find((candidate) => candidate.value === value || candidate.label === value);
      return option ? [option] : [];
    });
    return { dontKnow: false, ...(note ? { note } : {}), answers: quizAnswers(question, selected) };
  }
  if (answer.custom) {
    const custom = { type: "other", label: answer.custom, value: answer.custom };
    return question.multiSelect ? [custom] : custom;
  }
  const selected = (answer.selectedValues || []).flatMap((value) => {
    const option = question.options.find((candidate) => candidate.value === value || candidate.label === value);
    if (!option) return [];
    const index = question.options.findIndex((candidate) => candidate.value === option.value) + 1;
    return [{ type: "option", label: option.label, value: option.value, index }];
  });
  return question.multiSelect ? selected : selected[0] || null;
}

function parseMultiInput(question, value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "0") return { unknown: true, selectedValues: [] };
  const selectedValues = trimmed.split(/[ ,]+/).flatMap((token) => {
    const index = Number.parseInt(token, 10);
    if (!Number.isFinite(index) || index < 1) return [];
    const option = question.options[index - 1];
    return option ? [option.value] : [];
  });
  return { unknown: false, selectedValues };
}

function line(socket, value) {
  if (socket.destroyed) return;
  if (socket.writableLength > 1024 * 1024) { socket.destroy(); return; }
  try { socket.write(JSON.stringify(value) + "\n"); } catch { socket.destroy(); }
}

function writeLine(socket, serialized) {
  if (socket.destroyed) return;
  if (socket.writableLength > 1024 * 1024) { socket.destroy(); return; }
  try { socket.write(serialized); } catch { socket.destroy(); }
}

function createShared() {
  const root = registryRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const shared = {
    token: randomBytes(32).toString("hex"),
    root,
    server: undefined,
    registryPath: join(root, process.pid + ".json"),
    clients: new Set(),
    latestPi: undefined,
    latestContext: undefined,
    active: false,
    lastAdvertisementKey: undefined,
    liveAssistant: undefined,
    liveTools: new Map(),
    sequence: 0,
    pendingUi: new Map(),
    pendingQuestions: new Map(),
    pendingByToolCallId: new Map(),
    boundCustom: new Set(),
    answeredQuestions: new Set(),
    wrappedUi: undefined,
  };
  globalThis[QUESTION_API] = {
    contract: QUESTION_CONTRACT,
    ask(question) { return shared.askHost(question); },
  };

  shared.broadcast = (value) => {
    const event = { ...value, sequence: ++shared.sequence };
    if (shared.clients.size === 0) return event;
    let serialized;
    try { serialized = JSON.stringify(event) + "\n"; } catch { return event; }
    for (const client of shared.clients) writeLine(client, serialized);
    return event;
  };
  shared.advertise = () => {
    const pi = shared.latestPi;
    const ctx = shared.latestContext;
    const address = shared.server?.address();
    if (!pi || !ctx || !address || typeof address === "string") return;
    const stable = {
      version: VERSION,
      pid: process.pid,
      port: address.port,
      token: shared.token,
      mode: ctx.mode,
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
      sessionName: pi.getSessionName(),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      isStreaming: !ctx.isIdle(),
    };
    const key = JSON.stringify(stable);
    if (key === shared.lastAdvertisementKey) return;
    shared.lastAdvertisementKey = key;
    const payload = { ...stable, updatedAt: Date.now() };
    const temp = shared.registryPath + "." + Date.now() + ".tmp";
    writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(temp, shared.registryPath);
  };

  shared.settlePending = (map, id, value) => {
    const pending = map.get(id);
    if (!pending || !pending.resolve) {
      map.set(id, { queued: value });
      return true;
    }
    map.delete(id);
    pending.resolve(value);
    return true;
  };
  shared.waitMap = (map, id) => new Promise((resolve) => {
    const existing = map.get(id);
    if (existing && Object.prototype.hasOwnProperty.call(existing, "queued")) {
      map.delete(id);
      resolve(existing.queued);
      return;
    }
    map.set(id, { resolve, ...(existing || {}) });
  });
  shared.takeQueuedAnswer = (requestId, toolCallId) => {
    const byRequest = shared.pendingQuestions.get(requestId);
    if (byRequest && Object.prototype.hasOwnProperty.call(byRequest, "queued")) {
      shared.pendingQuestions.delete(requestId);
      return byRequest.queued;
    }
    if (!toolCallId) return;
    const mapped = shared.pendingByToolCallId.get(toolCallId);
    const pending = mapped ? shared.pendingQuestions.get(mapped) : shared.pendingQuestions.get(toolCallId);
    if (pending && Object.prototype.hasOwnProperty.call(pending, "queued")) {
      if (mapped) shared.pendingQuestions.delete(mapped);
      else shared.pendingQuestions.delete(toolCallId);
      shared.pendingByToolCallId.delete(toolCallId);
      return pending.queued;
    }
  };
  shared.askHost = (question) => {
    const requestId = String(question.requestId || newRequestId());
    const toolCallId = question.toolCallId ? String(question.toolCallId) : undefined;
    const payload = { ...question, contract: QUESTION_CONTRACT, requestId, ...(toolCallId ? { toolCallId } : {}) };
    const queued = shared.takeQueuedAnswer(requestId, toolCallId);
    if (queued !== undefined) {
      shared.answeredQuestions.add(requestId);
      if (toolCallId) shared.answeredQuestions.add(toolCallId);
      return Promise.resolve(queued);
    }
    const waiter = shared.waitMap(shared.pendingQuestions, requestId);
    const pending = shared.pendingQuestions.get(requestId);
    if (pending) pending.question = payload;
    if (toolCallId && !shared.pendingByToolCallId.has(toolCallId)) shared.pendingByToolCallId.set(toolCallId, requestId);
    shared.broadcast({ type: "heddlework_native_question", question: payload });
    return waiter.then((answer) => {
      shared.pendingQuestions.delete(requestId);
      if (toolCallId && shared.pendingByToolCallId.get(toolCallId) === requestId) shared.pendingByToolCallId.delete(toolCallId);
      shared.broadcast({ type: "heddlework_native_question_end", requestId, toolCallId });
      return answer;
    });
  };
  shared.pendingPromptRecords = () => {
    const prompts = [];
    for (const [id, pending] of shared.pendingUi) {
      prompts.push(pending.request || { type: "extension_ui_request", id, method: pending.method || "select" });
    }
    for (const pending of shared.pendingQuestions.values()) {
      if (pending.question && pending.question.stem) prompts.push({ type: "heddlework_native_question", question: pending.question });
    }
    return prompts;
  };
  shared.clearPrompts = () => {
    for (const pending of shared.pendingUi.values()) pending.resolve({ cancelled: true });
    shared.pendingUi.clear();
    for (const pending of shared.pendingQuestions.values()) {
      if (pending.resolve) pending.resolve({ cancelled: true });
    }
    shared.pendingQuestions.clear();
    shared.pendingByToolCallId.clear();
    shared.boundCustom.clear();
    shared.answeredQuestions.clear();
  };
  shared.wrapUi = (ctx) => {
    const ui = ctx && ctx.ui;
    if (!ui || ui.__heddleworkQuestionWrap) return;
    ui.__heddleworkQuestionWrap = true;
    const original = {
      select: ui.select ? ui.select.bind(ui) : undefined,
      confirm: ui.confirm ? ui.confirm.bind(ui) : undefined,
      input: ui.input ? ui.input.bind(ui) : undefined,
      editor: ui.editor ? ui.editor.bind(ui) : undefined,
      custom: ui.custom ? ui.custom.bind(ui) : undefined,
    };
    const raceUi = async (method, request, local, abort) => {
      const id = request.id;
      const remote = shared.waitMap(shared.pendingUi, id);
      shared.pendingUi.get(id).request = request;
      shared.pendingUi.get(id).method = method;
      shared.broadcast(request);
      const localResult = Promise.resolve().then(local);
      const winner = await Promise.race([
        localResult.then((value) => ({ source: "local", value })),
        remote.then((value) => ({ source: "remote", value })),
      ]);
      shared.pendingUi.delete(id);
      shared.broadcast({ type: "heddlework_ui_prompt_end", id });
      if (winner.source === "remote") {
        if (abort) abort.abort();
        if (winner.value && winner.value.cancelled) return method === "confirm" ? false : undefined;
        if (winner.value && Object.prototype.hasOwnProperty.call(winner.value, "confirmed")) return winner.value.confirmed;
        return winner.value ? winner.value.value : undefined;
      }
      return winner.value;
    };
    if (ctx.mode === "tui") {
      if (original.select) {
        ui.select = (title, options, opts) => {
          const id = Math.random().toString(36).slice(2);
          const abort = new AbortController();
          return raceUi("select", { type: "extension_ui_request", id, method: "select", title, options, timeout: opts && opts.timeout }, () => original.select(title, options, { ...opts, signal: abort.signal }), abort);
        };
      }
      if (original.confirm) {
        ui.confirm = (title, message, opts) => {
          const id = Math.random().toString(36).slice(2);
          const abort = new AbortController();
          return raceUi("confirm", { type: "extension_ui_request", id, method: "confirm", title, message, timeout: opts && opts.timeout }, () => original.confirm(title, message, { ...opts, signal: abort.signal }), abort);
        };
      }
      if (original.input) {
        ui.input = (title, placeholder, opts) => {
          const id = Math.random().toString(36).slice(2);
          const abort = new AbortController();
          return raceUi("input", { type: "extension_ui_request", id, method: "input", title, placeholder, timeout: opts && opts.timeout }, () => original.input(title, placeholder, { ...opts, signal: abort.signal }), abort);
        };
      }
      if (original.editor) {
        ui.editor = (title, prefill, opts) => {
          const id = Math.random().toString(36).slice(2);
          const abort = new AbortController();
          return raceUi("editor", { type: "extension_ui_request", id, method: "editor", title, prefill, timeout: opts && opts.timeout }, () => original.editor(title, prefill, { ...opts, signal: abort.signal }), abort);
        };
      }
    }
    ui.custom = async (factory, options) => {
      const bound = bindCustomQuestion(shared, options);
      if (!bound) {
        const id = newRequestId();
        shared.broadcast({
          type: "extension_ui_request",
          id,
          method: "unsupported",
          title: "Terminal-only extension UI",
          message: "This extension is drawing a custom terminal component. Heddlework cannot convert arbitrary TUI factories into a native form.",
        });
        return original.custom ? original.custom(factory, options) : undefined;
      }
      if (bound.toolCallId) shared.boundCustom.add(bound.toolCallId);
      if (ctx.mode !== "tui") {
        try {
          return await runRpcQuestion(ui, original, bound.question);
        } finally {
          if (bound.toolCallId) shared.boundCustom.delete(bound.toolCallId);
        }
      }
      const requestId = bound.requestId;
      let settled = false;
      let heldRemote;
      let resolveWinner;
      const finished = new Promise((resolve) => { resolveWinner = resolve; });
      const settle = (source, value, error) => {
        if (settled) return false;
        settled = true;
        if (source === "remote") heldRemote = resultFromAnswer(bound.question, value);
        resolveWinner({ source, value, error });
        return true;
      };
      let delivered = false;
      let pendingDone;
      const deliver = (done, value) => {
        if (delivered || typeof done !== "function") return;
        delivered = true;
        try { done(value); } catch {}
      };
      shared.askHost(bound.question).then(
        (value) => settle("remote", value),
        (error) => settle("remote", undefined, error),
      );
      let local = Promise.resolve(undefined);
      try {
        if (original.custom) {
          local = Promise.resolve().then(() => original.custom((tui, theme, kb, done) => {
            pendingDone = done;
            const wrappedDone = (value) => {
              settle("local", value);
              deliver(done, value);
            };
            const component = factory(tui, theme, kb, wrappedDone);
            if (settled) deliver(done, heldRemote);
            return component;
          }, options));
          local.then(
            (value) => settle("local", value),
            (error) => settle("local", undefined, error),
          );
        } else {
          settle("local", undefined);
        }
        const winner = await finished;
        if (winner.source === "remote") {
          deliver(pendingDone, heldRemote);
          if (winner.error) throw winner.error;
          return heldRemote;
        }
        shared.settlePending(shared.pendingQuestions, requestId, { cancelled: true });
        if (winner.error) throw winner.error;
        return winner.value;
      } finally {
        if (bound.toolCallId) shared.boundCustom.delete(bound.toolCallId);
        shared.answeredQuestions.add(requestId);
        if (bound.toolCallId) shared.answeredQuestions.add(bound.toolCallId);
        shared.pendingQuestions.delete(requestId);
        if (bound.toolCallId && shared.pendingByToolCallId.get(bound.toolCallId) === requestId) {
          shared.pendingByToolCallId.delete(bound.toolCallId);
        }
      }
    };
  };

  async function runRpcQuestion(ui, original, question) {
    const select = original.select || (ui.select && ui.select.bind(ui));
    const input = original.input || (ui.input && ui.input.bind(ui));
    const editor = original.editor || (ui.editor && ui.editor.bind(ui));
    if (question.allowText) {
      const title = question.description ? question.stem + "\n\n" + question.description : question.stem;
      const text = editor ? await editor(title) : await input(title);
      if (text === undefined) return null;
      return formatCustomResult(question, { text });
    }
    if (question.multiSelect) {
      const value = input ? await input(question.stem, "Enter numbers, comma-separated") : undefined;
      if (value === undefined) return null;
      const parsed = parseMultiInput(question, value);
      let note;
      if (question.allowNote && input) note = await input("Note (optional):");
      return formatCustomResult(question, { ...parsed, note });
    }
    const labels = question.options.map((option) => option.label);
    if (question.allowUnknown) labels.push(DONT_KNOW_LABEL);
    if (question.allowCustom) labels.push("Other");
    const choice = select ? await select(question.stem, labels) : undefined;
    if (choice === undefined) return null;
    if (choice === "Other") {
      const custom = input ? await input("Custom answer") : "";
      if (custom === undefined) return null;
      let note;
      if (question.allowNote && input) note = await input("Note (optional):");
      return formatCustomResult(question, { custom, note });
    }
    let note;
    if (question.allowNote && input) note = await input("Note (optional):");
    if (choice === DONT_KNOW_LABEL) return formatCustomResult(question, { unknown: true, note });
    const option = question.options.find((candidate) => candidate.label === choice);
    return formatCustomResult(question, { selectedValues: option ? [option.value] : [choice], note });
  }

  shared.server = createServer((socket) => {
    let authenticated = false;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    const authTimer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5000);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      while (true) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const raw = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        let request;
        try { request = JSON.parse(raw); } catch { socket.destroy(); return; }
        if (!authenticated) {
          if (request?.type !== "hello" || request?.version !== VERSION || request?.token !== shared.token) { socket.destroy(); return; }
          authenticated = true;
          clearTimeout(authTimer);
          shared.clients.add(socket);
          line(socket, { type: "bridge_ready", version: VERSION });
          continue;
        }
        void shared.handle(socket, request);
      }
    });
    socket.on("close", () => { clearTimeout(authTimer); shared.clients.delete(socket); });
    socket.on("error", () => { clearTimeout(authTimer); shared.clients.delete(socket); });
  });
  shared.server.listen(0, "127.0.0.1", () => shared.advertise());
  shared.server.unref();

  shared.handle = async (socket, request) => {
    const id = request?.id;
    const respond = (success, data, error) => line(socket, { type: "response", id, command: request?.type, success, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) });
    try {
      const pi = shared.latestPi;
      const ctx = shared.latestContext;
      if (!pi || !ctx) throw new Error("Pi session is not ready");
      if (request.type === "get_state") return respond(true, makeState(pi, ctx));
      if (request.type === "get_messages") return respond(true, { messages: branchMessages(ctx) });
      if (request.type === "get_available_models") return respond(true, { models: ctx.modelRegistry.getAvailable() });
      if (request.type === "get_commands") return respond(true, { commands: pi.getCommands() });
      if (request.type === "get_available_thinking_levels") return respond(true, { levels: supportedThinking(ctx.model) });
      if (request.type === "get_fork_messages") return respond(true, { messages: forkMessages(ctx) });
      if (request.type === "get_tree") return respond(true, { tree: ctx.sessionManager.getTree(), leafId: ctx.sessionManager.getLeafId() });
      if (request.type === "get_leaf") return respond(true, { leafId: ctx.sessionManager.getLeafId(), revision: shared.sequence });
      if (request.type === "get_session_stats") return respond(true, stats(ctx));
      if (request.type === "get_live_state") {
        const includeMessages = request.includeMessages === true;
        const rawLimit = Number.isFinite(request.messageLimit) ? Math.floor(request.messageLimit) : 40;
        const messageLimit = Math.max(0, Math.min(200, rawLimit));
        const allMessages = includeMessages ? branchMessages(ctx) : undefined;
        return respond(true, {
          state: makeState(pi, ctx),
          cwd: ctx.cwd,
          ...(allMessages === undefined ? {} : { messages: allMessages.slice(Math.max(0, allMessages.length - messageLimit)) }),
          assistant: shared.liveAssistant,
          tools: [...shared.liveTools.values()],
          prompts: shared.pendingPromptRecords(),
          sequence: shared.sequence,
        });
      }
      if (request.type === "extension_ui_response") {
        const settled = shared.settlePending(shared.pendingUi, request.id, request);
        return respond(true, { settled });
      }
      if (request.type === "answer_native_question") {
        const requestId = request.requestId || request.id;
        const toolCallId = request.toolCallId;
        if ((requestId && shared.answeredQuestions.has(requestId)) || (toolCallId && shared.answeredQuestions.has(toolCallId))) {
          return respond(true, { settled: false });
        }
        let target = requestId && shared.pendingQuestions.has(requestId) ? requestId : undefined;
        if (!target && toolCallId && shared.pendingByToolCallId.has(toolCallId)) target = shared.pendingByToolCallId.get(toolCallId);
        if (!target && requestId && shared.pendingByToolCallId.has(requestId)) target = shared.pendingByToolCallId.get(requestId);
        if (!target && toolCallId && shared.pendingQuestions.has(toolCallId)) target = toolCallId;
        if (!target) target = requestId || toolCallId;
        if (!target) return respond(true, { settled: false });
        const settled = shared.settlePending(shared.pendingQuestions, target, request.answer || request);
        return respond(true, { settled });
      }
      if (request.type === "abort") { ctx.abort(); return respond(true); }
      if (request.type === "prompt" || request.type === "steer" || request.type === "follow_up") {
        if (typeof request.message !== "string") throw new Error("message must be a string");
        const deliverAs = request.type === "steer" ? "steer" : request.type === "follow_up" ? "followUp" : request.streamingBehavior;
        const images = Array.isArray(request.images) ? request.images : [];
        for (const image of images) {
          if (!image || image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") throw new Error("Invalid prompt image");
        }
        const content = images.length === 0 ? request.message : [{ type: "text", text: request.message }, ...images];
        pi.sendUserMessage(content, { ...(deliverAs ? { deliverAs } : {}), expandPromptTemplates: request.type === "prompt" });
        return respond(true);
      }
      if (request.type === "set_thinking_level") { pi.setThinkingLevel(request.level); return respond(true); }
      if (request.type === "set_session_name") {
        const name = String(request.name ?? "").trim();
        if (!name) throw new Error("Session name cannot be empty");
        pi.setSessionName(name);
        return respond(true);
      }
      if (request.type === "set_model") {
        const model = ctx.modelRegistry.find(request.provider, request.modelId);
        if (!model) throw new Error("Model not found");
        if (!(await pi.setModel(model))) throw new Error("Model authentication unavailable");
        return respond(true, model);
      }
      throw new Error("Unsupported live command: " + request.type);
    } catch (error) {
      respond(false, undefined, errorText(error));
    }
  };
  return shared;
}

export default function heddleworkLiveBridge(pi) {
  const shared = globalThis[KEY] || (globalThis[KEY] = createShared());
  if (typeof pi.registerTool === "function" && !pi.registerTool.__hwAls) {
    const registerTool = pi.registerTool.bind(pi);
    const wrappedRegister = (tool) => {
      wrapToolExecute(tool);
      return registerTool(tool);
    };
    wrappedRegister.__hwAls = true;
    pi.registerTool = wrappedRegister;
  }
  if (shared.active) return;
  shared.active = true;
  const emitSessionState = (ctx) => {
    const record = { type: "heddlework_session_state", state: makeState(pi, ctx), cwd: ctx.cwd };
    const sequenced = shared.broadcast(record);
    if (ctx.mode === "rpc") ctx.ui.setWidget(STATE_WIDGET, [JSON.stringify(sequenced)]);
  };
  const setContext = (ctx) => { shared.latestContext = ctx; shared.wrapUi(ctx); };
  pi.on("session_start", (_event, ctx) => {
    shared.latestPi = pi;
    setContext(ctx);
    shared.liveAssistant = undefined;
    shared.liveTools.clear();
    shared.clearPrompts();
    shared.lastAdvertisementKey = undefined;
    shared.advertise();
    shared.broadcast({ type: "session_switched", state: makeState(pi, ctx) });
    emitSessionState(ctx);
  });
  for (const eventName of ["agent_start", "agent_settled", "model_select", "thinking_level_select", "session_info_changed"]) {
    pi.on(eventName, (event, ctx) => {
      if (shared.latestPi !== pi) return;
      setContext(ctx);
      if (eventName === "agent_settled") {
        shared.liveAssistant = undefined;
        shared.liveTools.clear();
      }
      shared.advertise();
      shared.broadcast(event);
      emitSessionState(ctx);
    });
  }
  for (const eventName of ["agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "session_compact", "session_compact_failed", "session_tree"]) {
    pi.on(eventName, (event, ctx) => {
      if (shared.latestPi !== pi) return;
      setContext(ctx);
      if ((eventName === "message_start" || eventName === "message_update" || eventName === "message_end") && event.message?.role === "assistant") shared.liveAssistant = event.message;
      else if (eventName === "tool_execution_start") shared.liveTools.set(event.toolCallId, event);
      else if (eventName === "tool_execution_update" || eventName === "tool_execution_end") {
        const previous = shared.liveTools.get(event.toolCallId) || {};
        shared.liveTools.set(event.toolCallId, { ...previous, ...event });
        if (eventName === "tool_execution_end") {
          const mapped = shared.pendingByToolCallId.get(event.toolCallId);
          if (mapped) {
            shared.settlePending(shared.pendingQuestions, mapped, { cancelled: true });
            shared.pendingByToolCallId.delete(event.toolCallId);
            shared.boundCustom.delete(event.toolCallId);
            shared.broadcast({ type: "heddlework_native_question_end", requestId: mapped, toolCallId: event.toolCallId });
          }
        }
      }
      shared.broadcast(eventName === "message_update" ? projectMessageUpdate(event) : event);
    });
  }
  pi.on("session_shutdown", (event, ctx) => {
    if (shared.latestPi !== pi) return;
    setContext(ctx);
    shared.broadcast(event);
    shared.active = false;
    shared.liveAssistant = undefined;
    shared.liveTools.clear();
    shared.clearPrompts();
    if (event.reason !== "quit") return;
    for (const client of shared.clients) client.destroy();
    shared.clients.clear();
    shared.server?.close();
    rmSync(shared.registryPath, { force: true });
    delete globalThis[KEY];
  });
}
`
