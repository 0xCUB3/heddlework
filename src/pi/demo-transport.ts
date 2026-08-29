import type { AgentTransport, TransportStatus } from './transport.ts'
import type { PiForkMessage, PiImageContent, PiMessage, PiModel, PiSessionState, RpcCommand, RpcRecord, ThinkingLevel } from './types.ts'

const models: PiModel[] = [
  { provider: 'demo', id: 'heddlework', name: 'Heddlework Demo', reasoning: true, contextWindow: 200_000, input: ['text', 'image'] },
  { provider: 'demo', id: 'fast', name: 'Demo Fast', reasoning: false, contextWindow: 128_000 },
]

export class DemoTransport implements AgentTransport {
  readonly #events = new Set<(event: RpcRecord) => void>()
  readonly #statuses = new Set<(status: TransportStatus) => void>()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  #messages: PiMessage[] = []
  #forkMessages: PiForkMessage[] = []
  #model = models[0]!
  #thinking: ThinkingLevel = 'medium'
  #running = false
  #sessionId = crypto.randomUUID()
  #sessionName: string | undefined = 'Demo session'

  async start(): Promise<void> {
    this.#emitStatus({ state: 'starting' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    this.#emitStatus({ state: 'running', pid: process.pid })
  }

  async stop(): Promise<void> {
    this.#cancelTimers()
    this.#running = false
    this.#emitStatus({ state: 'stopped' })
  }

  onEvent(listener: (event: RpcRecord) => void): () => void {
    this.#events.add(listener)
    return () => this.#events.delete(listener)
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.#statuses.add(listener)
    return () => this.#statuses.delete(listener)
  }

  getStderr(): string {
    return ''
  }

  send(_record: RpcRecord): void {}

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    switch (command.type) {
      case 'get_state':
        return this.#state() as T
      case 'get_messages':
        return { messages: this.#messages } as T
      case 'get_fork_messages':
        return { messages: this.#forkMessages } as T
      case 'get_available_models':
        return { models } as T
      case 'get_available_thinking_levels':
        return { levels: this.#model.reasoning ? ['off', 'low', 'medium', 'high'] : ['off'] } as T
      case 'get_session_stats':
        return {
          sessionId: this.#sessionId,
          totalMessages: this.#messages.length,
          toolCalls: this.#messages.filter((message) => message.role === 'toolResult').length,
          cost: 0,
          contextUsage: { tokens: this.#messages.length * 420, contextWindow: 200_000, percent: Math.min(99, this.#messages.length * 0.21) },
        } as T
      case 'prompt':
        this.#run(String(command.message ?? ''), imageCommands(command.images))
        return undefined as T
      case 'abort':
        this.#cancelTimers()
        this.#running = false
        this.#emit({ type: 'agent_settled' })
        return undefined as T
      case 'new_session':
        this.#cancelTimers()
        this.#messages = []
        this.#forkMessages = []
        this.#sessionId = crypto.randomUUID()
        this.#sessionName = undefined
        return { cancelled: false } as T
      case 'clone':
        this.#sessionId = crypto.randomUUID()
        return { cancelled: false } as T
      case 'fork': {
        const selected = this.#forkMessages.find((message) => message.entryId === command.entryId)
        if (!selected) throw new Error('Fork message not found')
        const userIndex = this.#messages.findIndex((message) => message.role === 'user' && messageText(message) === selected.text)
        this.#messages = userIndex > 0 ? this.#messages.slice(0, userIndex) : []
        this.#forkMessages = this.#forkMessages.slice(0, Math.max(0, this.#forkMessages.indexOf(selected)))
        this.#sessionId = crypto.randomUUID()
        return { text: selected.text, cancelled: false } as T
      }
      case 'set_model':
        this.#model = models.find((model) => model.provider === command.provider && model.id === command.modelId) ?? this.#model
        if (!this.#model.reasoning) this.#thinking = 'off'
        return this.#model as T
      case 'set_session_name':
        this.#sessionName = String(command.name ?? '').trim() || undefined
        return undefined as T
      case 'set_thinking_level':
        this.#thinking = String(command.level ?? 'off') as ThinkingLevel
        return undefined as T
      case 'compact':
        this.#emit({ type: 'compaction_start', reason: 'manual' })
        this.#schedule(250, () => this.#emit({ type: 'compaction_end', reason: 'manual' }))
        return { summary: 'Demo context compacted' } as T
      default:
        return undefined as T
    }
  }

  #state(): PiSessionState {
    return {
      model: this.#model,
      thinkingLevel: this.#thinking,
      isStreaming: this.#running,
      sessionId: this.#sessionId,
      ...(this.#sessionName ? { sessionName: this.#sessionName } : {}),
    }
  }

  #run(prompt: string, images: PiImageContent[]): void {
    if (this.#running) return
    this.#running = true
    const now = Date.now()
    const entryId = `demo-entry-${now}`
    this.#forkMessages.push({ entryId, text: prompt })
    this.#messages.push({
      role: 'user',
      content: images.length > 0 ? [...(prompt ? [{ type: 'text' as const, text: prompt }] : []), ...images] : prompt,
      timestamp: now,
    })
    const callId = `demo-${now}`
    const intro = 'I’ll inspect the workspace and report back.'
    const answer = 'The workbench transport, event reducer, and native GPUIX transcript are connected. Replace demo mode with the real `pi --mode rpc` process to work on this repository.'

    this.#emit({ type: 'agent_start' })
    this.#emit({ type: 'turn_start' })
    this.#emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: now + 1 } })
    this.#schedule(80, () => this.#emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: intro } }))
    this.#schedule(280, () => {
      const assistant: PiMessage = {
        role: 'assistant',
        timestamp: now + 1,
        content: [
          { type: 'text', text: intro },
          { type: 'toolCall', id: callId, name: 'bash', arguments: { command: 'git status --short' } },
        ],
      }
      this.#messages.push(assistant)
      this.#emit({ type: 'message_end', message: assistant })
      this.#emit({ type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: { command: 'git status --short' } })
    })
    this.#schedule(520, () => this.#emit({
      type: 'tool_execution_update',
      toolCallId: callId,
      toolName: 'bash',
      args: { command: 'git status --short' },
      partialResult: { content: [{ type: 'text', text: 'M src/workbench/controller.ts\n?? src/ui/' }] },
    }))
    this.#schedule(760, () => {
      const result: PiMessage = {
        role: 'toolResult',
        toolCallId: callId,
        toolName: 'bash',
        content: [{ type: 'text', text: 'M src/workbench/controller.ts\n?? src/ui/' }],
        isError: false,
        timestamp: now + 2,
      }
      this.#messages.push(result)
      this.#emit({ type: 'tool_execution_end', toolCallId: callId, toolName: 'bash', result: { content: result.content }, isError: false })
      this.#emit({ type: 'turn_end', message: this.#messages.at(-2), toolResults: [result] })
      this.#emit({ type: 'turn_start' })
      this.#emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: now + 3 } })
    })
    const chunks = ['The workbench transport, event reducer, ', 'and native GPUIX transcript are connected. ', 'Replace demo mode with the real `pi --mode rpc` process to work on this repository.']
    chunks.forEach((chunk, index) => this.#schedule(940 + index * 150, () => this.#emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk },
    })))
    this.#schedule(1_450, () => {
      const assistant: PiMessage = { role: 'assistant', content: [{ type: 'text', text: answer }], timestamp: now + 3 }
      this.#messages.push(assistant)
      this.#emit({ type: 'message_end', message: assistant })
      this.#emit({ type: 'turn_end', message: assistant, toolResults: [] })
      this.#emit({ type: 'agent_end', messages: this.#messages, willRetry: false })
      this.#running = false
      this.#emit({ type: 'agent_settled' })
    })
  }

  #schedule(delay: number, callback: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      callback()
    }, delay)
    this.#timers.add(timer)
  }

  #cancelTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
  }

  #emit(event: RpcRecord): void {
    for (const listener of this.#events) listener(event)
  }

  #emitStatus(status: TransportStatus): void {
    for (const listener of this.#statuses) listener(status)
  }
}

function imageCommands(value: unknown): PiImageContent[] {
  if (!Array.isArray(value)) return []
  return value.filter((image): image is PiImageContent => (
    Boolean(image)
    && typeof image === 'object'
    && (image as { type?: unknown }).type === 'image'
    && typeof (image as { data?: unknown }).data === 'string'
    && typeof (image as { mimeType?: unknown }).mimeType === 'string'
  ))
}

function messageText(message: PiMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.map((block) => block.type === 'text' ? block.text ?? '' : '').join('\n').trim()
}
