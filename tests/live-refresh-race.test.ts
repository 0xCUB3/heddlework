import { describe, expect, it } from 'bun:test'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { PiMessage, PiSessionState, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

class LiveTransport implements AgentTransport {
  state: PiSessionState = { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'live-test' }
  messages: PiMessage[] = []
  stateGate: Promise<PiSessionState> | undefined
  messagesGate: Promise<{ messages: PiMessage[] }> | undefined
  rejectForks = false
  messageReads = 0
  readonly events = new Set<(event: RpcRecord) => void>()
  async start() {}
  async stop() {}
  send() {}
  getStderr() { return '' }
  onStatus(_callback: (status: TransportStatus) => void) { return () => undefined }
  onEvent(callback: (event: RpcRecord) => void) { this.events.add(callback); return () => { this.events.delete(callback) } }
  emit(event: RpcRecord) {
    if (event.type === 'agent_start') this.state = { ...this.state, isStreaming: true }
    if (event.type === 'agent_settled') this.state = { ...this.state, isStreaming: false }
    for (const callback of this.events) callback(event)
  }
  async request<T = unknown>(command: RpcCommand): Promise<T> {
    switch (command.type) {
      case 'get_state': return (await (this.stateGate ?? this.state)) as T
      case 'get_messages': this.messageReads++; return (await (this.messagesGate ?? { messages: this.messages })) as T
      case 'get_tree': return undefined as T
      case 'get_available_models': return { models: [] } as T
      case 'get_available_thinking_levels': return { levels: ['off'] } as T
      case 'get_commands': return { commands: [] } as T
      case 'get_fork_messages': if (this.rejectForks) throw new Error('Unsupported optional command'); return { messages: [] } as T
      case 'get_session_stats': return {} as T
      default: return undefined as T
    }
  }
}

function createController(transport: LiveTransport) {
  return new WorkbenchController(transport, '/tmp/live-refresh-test', {
    sessionCatalog: { list: async () => [], createWorkspaceSession: async () => { throw new Error('unused') } },
    workspaceDiff: { load: async () => ({ status: 'ready', branch: '', files: [], additions: 0, deletions: 0 }) },
  })
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Expected refresh did not settle'); await Bun.sleep(5) }
}

describe('live transcript reconciliation', () => {
  it('keeps the next response and running tool when an older transcript refresh finishes late', async () => {
    const transport = new LiveTransport()
    const controller = createController(transport)
    await controller.start()
    const oldAssistant: PiMessage = { role: 'assistant', content: 'old response', timestamp: 1 }
    const gate = deferred<{ messages: PiMessage[] }>()
    try {
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_start', message: oldAssistant })
      transport.messagesGate = gate.promise
      transport.emit({ type: 'message_end', message: oldAssistant })
      await waitFor(() => transport.messageReads === 2)
      transport.emit({ type: 'message_start', message: { role: 'assistant', timestamp: 2, content: [] } })
      transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'new response' } })
      transport.emit({ type: 'tool_execution_start', toolCallId: 'new-tool', toolName: 'read' })
      gate.resolve({ messages: [oldAssistant] })
      await waitFor(() => controller.getSnapshot().messages.length === 1)
      expect(controller.getSnapshot().liveAssistant?.blocks[0]?.text).toBe('new response')
      expect(controller.getSnapshot().liveTools[0]?.id).toBe('new-tool')
    } finally { gate.resolve({ messages: [] }); await controller.dispose() }
  })

  it('does not duplicate a completed live row once its durable message is present', async () => {
    const transport = new LiveTransport()
    const controller = createController(transport)
    await controller.start()
    try {
      const message = { role: 'assistant', content: 'done', timestamp: 10 }
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_start', message })
      transport.messages = [message]
      transport.emit({ type: 'message_end', message })
      await waitFor(() => controller.getSnapshot().messages.length === 1)
      expect(controller.getSnapshot().liveAssistant).toBeUndefined()
    } finally { await controller.dispose() }
  })

  it('a stale idle bootstrap cannot clear a new stream', async () => {
    const transport = new LiveTransport()
    const gate = deferred<PiSessionState>()
    transport.stateGate = gate.promise
    const controller = createController(transport)
    const starting = controller.start()
    try {
      await Bun.sleep(0)
      transport.emit({ type: 'agent_start' })
      transport.emit({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'in progress' }], timestamp: 5 } })
      gate.resolve({ model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'live-test' })
      await starting
      expect(controller.getSnapshot().session.isStreaming).toBe(true)
      expect(controller.getSnapshot().liveAssistant?.blocks[0]?.text).toBe('in progress')
    } finally { gate.resolve(transport.state); await starting; await controller.dispose() }
  })

  it('missing optional fork metadata does not prevent transcript refresh', async () => {
    const transport = new LiveTransport()
    transport.rejectForks = true
    const controller = createController(transport)
    await controller.start()
    try {
      transport.messages = [{ role: 'user', content: 'from TUI', timestamp: 6 }]
      transport.emit({ type: 'message_end', message: transport.messages[0] })
      await waitFor(() => controller.getSnapshot().messages.length === 1)
      expect(controller.getSnapshot().messages[0]?.content).toBe('from TUI')
      expect(controller.getSnapshot().notices).toHaveLength(0)
    } finally { await controller.dispose() }
  })
})
