import { describe, expect, it } from 'bun:test'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { PiSessionState, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { parseBuiltinSlashCommand } from '../src/pi/slash-commands.ts'
import { HEDDLEWORK_FABRIC_BRIDGE_PREFIX, HEDDLEWORK_FABRIC_BRIDGE_WIDGET } from '../src/pi/fabric-bridge.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { moveQueuedInput } from '../src/workbench/queue.ts'
import { compileFlowQueue } from '../src/flows/compiler.ts'
import type { FlowLaunch } from '../src/flows/types.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

class QueueTransport implements AgentTransport {
  readonly commands: RpcCommand[] = []
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  readonly sent: RpcRecord[] = []
  streaming = false

  async start(): Promise<void> {
    for (const listener of this.statuses) listener({ state: 'running', pid: process.pid })
  }

  async stop(): Promise<void> {}
  send(record: RpcRecord): void { this.sent.push(record) }
  getStderr(): string { return '' }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener) }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    this.commands.push(command)
    if (command.type === 'get_state') {
      return { model: null, thinkingLevel: 'off', isStreaming: this.streaming, sessionId: 'queue-session', sessionFile: '/tmp/queue-session.jsonl' } satisfies PiSessionState as T
    }
    if (command.type === 'get_messages') return { messages: [] } as T
    if (command.type === 'get_fork_messages') return { messages: [{ entryId: 'fork-entry', text: 'Original user prompt' }] } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { sessionId: 'queue-session', totalMessages: 0, toolCalls: 0, cost: 0 } as T
    if (command.type === 'prompt' && String(command.message).startsWith(HEDDLEWORK_FABRIC_BRIDGE_PREFIX)) return {} as T
    if (command.type === 'prompt' && !command.streamingBehavior) {
      this.streaming = true
      this.emit({ type: 'agent_start' })
    }
    if (command.type === 'abort') {
      this.streaming = false
      this.emit({ type: 'agent_settled' })
    }
    if (command.type === 'new_session' || command.type === 'switch_session' || command.type === 'clone') return { cancelled: false } as T
    if (command.type === 'fork') return { text: 'Original user prompt', cancelled: false } as T
    if (command.type === 'export_html') return { path: String(command.outputPath ?? '/tmp/queue-session.html') } as T
    if (command.type === 'get_last_assistant_text') return { text: 'Last assistant response' } as T
    return undefined as T
  }

  turnEnd(stopReason: 'toolUse' | 'stop' | 'error' | 'aborted' = 'toolUse'): void {
    this.emit({ type: 'turn_end', message: { role: 'assistant', content: [], stopReason }, toolResults: [] })
  }

  settle(stopReason: 'stop' | 'error' | 'length' = 'stop'): void {
    this.streaming = false
    this.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason }], willRetry: false })
    this.emit({ type: 'agent_settled' })
  }

  private emit(event: RpcRecord): void {
    for (const listener of this.events) listener(event)
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function fabricBridgeRecord(payload: Record<string, unknown>): RpcRecord {
  return {
    type: 'extension_ui_request',
    id: `bridge-${String(payload.requestId ?? 'event')}`,
    method: 'setWidget',
    widgetKey: HEDDLEWORK_FABRIC_BRIDGE_WIDGET,
    widgetLines: [JSON.stringify({ version: 1, ...payload })],
  }
}

describe('owned workbench queue', () => {
  it('executes idle built-ins locally and sends only RPC-invokable custom commands as prompts', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/idle-controls', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('/compact focus on decisions')
      await controller.submit('/model provider/model')
      await controller.submit('/thinking off')
      await controller.submit('/name Release audit')
      await controller.submit('/export "/tmp/release audit.html"')
      await controller.submit('/session')
      await controller.submit('/clone')

      expect(transport.commands.filter((command) => command.type === 'prompt')).toEqual([])
      expect(transport.commands).toContainEqual({ type: 'compact', customInstructions: 'focus on decisions' })
      expect(transport.commands).toContainEqual({ type: 'set_model', provider: 'provider', modelId: 'model' })
      expect(transport.commands).toContainEqual({ type: 'set_thinking_level', level: 'off' })
      expect(transport.commands).toContainEqual({ type: 'set_session_name', name: 'Release audit' })
      expect(transport.commands).toContainEqual({ type: 'export_html', outputPath: '/tmp/release audit.html' })
      expect(transport.commands.some((command) => command.type === 'clone')).toBe(true)
      expect(controller.getSnapshot().messages.some((message) => message.workbenchOptimistic)).toBe(false)

      await controller.submit('/settings')
      expect(controller.getSnapshot().uiRequest).toMatchObject({ kind: 'settings' })
      controller.completeUiRequest(controller.getSnapshot().uiRequest!.id)
      await controller.submit('/model')
      expect(controller.getSnapshot().uiRequest).toMatchObject({ kind: 'model' })
      controller.completeUiRequest(controller.getSnapshot().uiRequest!.id)
      await controller.submit('/copy')
      expect(controller.getSnapshot().uiRequest).toMatchObject({ kind: 'copy', text: 'Last assistant response' })
      controller.completeUiRequest(controller.getSnapshot().uiRequest!.id)

      await controller.submit('/tree')
      expect(controller.getSnapshot().notices.at(-1)).toMatchObject({ kind: 'warning' })
      expect(transport.commands.filter((command) => command.type === 'prompt')).toEqual([])

      await controller.submit('/fabric status')
      expect(transport.commands.filter((command) => command.type === 'prompt')).toEqual([
        expect.objectContaining({ message: '/fabric status' }),
      ])
    } finally {
      await controller.dispose()
    }
  })

  it('uses a native selector for /fork without replying to Pi as an extension dialog', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/fork-command', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('/fork')
      const dialog = controller.getSnapshot().dialog
      expect(dialog).toMatchObject({ method: 'select', title: 'Fork from a previous message' })
      controller.respondToDialog({ value: dialog!.options![0]! })
      await waitFor(() => transport.commands.some((command) => command.type === 'fork')
        && controller.getSnapshot().editorText === 'Original user prompt', 'the selected fork command')
      expect(transport.sent).toEqual([])
      expect(controller.getSnapshot().editorText).toBe('Original user prompt')
    } finally {
      await controller.dispose()
    }
  })

  it('stages stopped submissions without starting Pi and resumes from the parked head', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-stopped', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('/new', { queue: true })
      await controller.submit('Start only when resumed', { queue: true })
      expect(controller.getSnapshot().session.isStreaming).toBe(false)
      expect(controller.getSnapshot().queue.paused).toBe(true)
      expect(controller.getSnapshot().queue.pauseReason).toBe('manual')
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['/new', 'Start only when resumed'])
      expect(transport.commands.filter((command) => command.type === 'prompt')).toHaveLength(0)

      controller.resumeQueue()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Start only when resumed')
        && controller.getSnapshot().queue.items.length === 0, 'the resumed prompt')
      expect(transport.commands.find((command) => command.type === 'new_session')).toEqual({ type: 'new_session', parentSession: '/tmp/queue-session.jsonl' })
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: 'Start only when resumed' })
      expect(controller.getSnapshot().queue.items).toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  it('keeps twenty raw rows editable and reorderable, steers explicitly, and pauses across abort', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-workspace', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start the active run')
      expect(controller.getSnapshot().session.isStreaming).toBe(true)

      for (let index = 1; index <= 20; index += 1) {
        controller.setEditorText(index === 1 ? '/skill:review keep this shorthand' : `Queued task ${index}`)
        await controller.submit(controller.getSnapshot().editorText)
      }
      expect(controller.getSnapshot().queue.items).toHaveLength(20)
      expect(transport.commands.filter((command) => command.type === 'prompt')).toHaveLength(1)

      const slash = controller.getSnapshot().queue.items[0]!
      const last = controller.getSnapshot().queue.items.at(-1)!
      controller.updateQueuedInput(slash.id, '/skill:review edited before expansion')
      controller.moveQueuedInput(last.id, 0)
      expect(controller.getSnapshot().queue.items[0]?.id).toBe(last.id)
      expect(controller.getSnapshot().queue.items[1]?.text).toBe('/skill:review edited before expansion')

      await controller.steerQueuedInput(slash.id)
      const steer = transport.commands.filter((command) => command.type === 'prompt').at(-1)!
      expect(steer).toMatchObject({ type: 'prompt', message: '/skill:review edited before expansion', streamingBehavior: 'steer' })
      expect(controller.getSnapshot().queue.items.some((item) => item.id === slash.id)).toBe(false)
      expect(controller.getSnapshot().queue.steering[0]).toBe('/skill:review edited before expansion')

      await controller.abort()
      await waitFor(() => controller.getSnapshot().queue.pauseReason === 'abort', 'the aborted queue to pause')
      expect(controller.getSnapshot().queue.paused).toBe(true)
      expect(controller.getSnapshot().queue.pauseReason).toBe('abort')
      expect(transport.commands.filter((command) => command.type === 'prompt')).toHaveLength(2)

      controller.resumeQueue()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Queued task 20')
        && !controller.getSnapshot().queue.items.some((item) => item.id === last.id), 'the queue to resume')
      const resumed = transport.commands.filter((command) => command.type === 'prompt').at(-1)!
      expect(resumed).toMatchObject({ type: 'prompt', message: 'Queued task 20' })
      expect('streamingBehavior' in resumed).toBe(false)
      expect(controller.getSnapshot().queue.items.some((item) => item.id === last.id)).toBe(false)
    } finally {
      await controller.dispose()
    }
  })

  it('delivers steering at turn boundaries and follow-ups only after settlement', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-lanes', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      await controller.submit('Steer at the next turn')
      await controller.submit('/new')
      await controller.submit('Follow after the run', { queue: true })
      expect(controller.getSnapshot().queue.items.map((item) => item.lane)).toEqual(['steer', 'steer', 'followUp'])

      transport.turnEnd()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Steer at the next turn' && command.streamingBehavior === 'steer') && !controller.getSnapshot().queue.items.some((item) => item.text === 'Steer at the next turn'), 'the turn-boundary steering row')
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['/new', 'Follow after the run'])
      expect(transport.commands.some((command) => command.type === 'new_session')).toBe(false)

      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'new_session') && transport.commands.some((command) => command.type === 'prompt' && command.message === 'Follow after the run' && !command.streamingBehavior) && !controller.getSnapshot().queue.items.some((item) => item.text === 'Follow after the run'), 'the settled session handoff and follow-up row')
      expect(transport.commands.find((command) => command.type === 'new_session')).toEqual({ type: 'new_session', parentSession: '/tmp/queue-session.jsonl' })
      expect(controller.getSnapshot().queue.items).toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  it('drains ordinary messages in timeline order without collapsing control rows', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-drain-all', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      await controller.submit('First queued message')
      await controller.submit('Second queued message', { queue: true })
      controller.queueInput('/compact keep decisions', [], { lane: 'followUp' })
      controller.queueInput('/name Release train', [], { lane: 'followUp' })
      await controller.drainQueueMessages()
      const drained = transport.commands.filter((command) => command.type === 'prompt').at(-1)
      expect(drained).toMatchObject({ message: 'First queued message\n\nSecond queued message', streamingBehavior: 'steer' })
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['/compact keep decisions', '/name Release train'])
    } finally {
      await controller.dispose()
    }
  })

  it('arms a graceful pause until every in-flight tool finishes', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-pause', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      controller.acceptAgentEvent({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'sleep 1' } })
      await controller.pause()
      expect(transport.commands.filter((command) => command.type === 'abort')).toEqual([])
      expect(controller.getSnapshot().queue).toMatchObject({ paused: true, pauseReason: 'manual' })

      controller.acceptAgentEvent({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash', result: { content: [] }, isError: false })
      await waitFor(() => transport.commands.some((command) => command.type === 'abort'), 'graceful pause after tool completion')
      expect(controller.getSnapshot().session.isStreaming).toBe(false)
    } finally {
      await controller.dispose()
    }
  })

  it('dispatches exactly one queued row at each healthy settled boundary', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-drain', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      await controller.submit('/fabric status')
      await controller.submit('Implement after extension command')

      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === '/fabric status')
        && controller.getSnapshot().queue.items.length === 1, 'the first queued prompt')
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: '/fabric status' })
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['Implement after extension command'])

      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Implement after extension command')
        && controller.getSnapshot().queue.items.length === 0, 'the second queued prompt')
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: 'Implement after extension command' })
      expect(controller.getSnapshot().queue.items).toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  it('runs built-in controls in place and leaves extension commands raw', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-controls', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      await controller.submit('/compact focus on decisions')
      await controller.submit('/model provider/model')
      await controller.submit('/thinking off')
      await controller.submit('/new')
      await controller.submit('/reload')
      await controller.submit('/fabric status')
      await controller.submit('Implement after controls')

      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === '/fabric status')
        && controller.getSnapshot().queue.items.length === 1
        && controller.getSnapshot().queue.items[0]?.text === 'Implement after controls', 'the queued controls and extension command')
      const controlCommands = transport.commands.filter((command) => ['compact', 'set_model', 'set_thinking_level', 'new_session', 'switch_session'].includes(command.type))
      expect(controlCommands.map((command) => command.type)).toEqual(['compact', 'set_model', 'set_thinking_level', 'new_session', 'switch_session'])
      expect(controlCommands[0]).toMatchObject({ type: 'compact', customInstructions: 'focus on decisions' })
      expect(controlCommands.at(-1)).toMatchObject({ type: 'switch_session', sessionPath: '/tmp/queue-session.jsonl' })
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: '/fabric status' })
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['Implement after controls'])
    } finally {
      await controller.dispose()
    }
  })

  it('treats an idle image-bearing built-in as a prompt so attachments are preserved', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/idle-image-control', testControllerDependencies())
    try {
      await controller.start()
      controller.addEditorImage({ id: 'image-idle', type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', previewPath: '/tmp/image.png', fileName: 'image.png', size: 5 })
      await controller.submit('/compact')
      expect(transport.commands.filter((command) => command.type === 'compact')).toEqual([])
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({
        message: '/compact',
        images: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      })
    } finally {
      await controller.dispose()
    }
  })

  it('treats image-bearing slash text as a message instead of a control row', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-image-control', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      controller.queueInput('/new', [{ id: 'image-1', type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', previewPath: '/tmp/image.png', fileName: 'image.png', size: 5 }])
      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === '/new')
        && controller.getSnapshot().queue.items.length === 0, 'the image-bearing slash prompt')
      expect(transport.commands.filter((command) => command.type === 'new_session')).toHaveLength(0)
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({
        type: 'prompt',
        message: '/new',
        images: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      })
    } finally {
      await controller.dispose()
    }
  })

  it('holds the tail after a terminal run error', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-error', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      await controller.submit('Do not run after an error')
      transport.settle('error')
      await waitFor(() => controller.getSnapshot().queue.pauseReason === 'error', 'the errored queue to pause')
      expect(controller.getSnapshot().queue.paused).toBe(true)
      expect(controller.getSnapshot().queue.pauseReason).toBe('error')
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['Do not run after an error'])
      expect(transport.commands.filter((command) => command.type === 'prompt')).toHaveLength(1)

      controller.acceptAgentEvent({ type: 'agent_start' })
      controller.acceptAgentEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'stop' }], willRetry: false })
      controller.acceptAgentEvent({ type: 'agent_settled' })
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Do not run after an error')
        && controller.getSnapshot().queue.items.length === 0, 'the recovered queue prompt')
      expect(controller.getSnapshot().queue.paused).toBe(false)
      expect(transport.commands.filter((command) => command.type === 'prompt').at(-1)).toMatchObject({ message: 'Do not run after an error' })
    } finally {
      await controller.dispose()
    }
  })

  it('releases a length-error queue hold after successful compaction', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-overflow', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('Start')
      await controller.submit('Continue after compaction', { queue: true })
      transport.settle('length')
      await waitFor(() => controller.getSnapshot().queue.pauseReason === 'error', 'the overflow error hold')
      controller.acceptAgentEvent({ type: 'compaction_start', reason: 'overflow' })
      controller.acceptAgentEvent({ type: 'compaction_end', reason: 'overflow' })
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Continue after compaction') && controller.getSnapshot().queue.items.length === 0, 'the compacted queue tail')
      expect(controller.getSnapshot().queue.paused).toBe(false)
    } finally {
      await controller.dispose()
    }
  })

  it('dispatches a sequential Flow as linked fresh Pi sessions', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/flow-queue-controller', testControllerDependencies())
    const flow: FlowLaunch = {
      id: 'HW-CONTROL',
      title: 'Controller flow',
      prompts: ['First fresh task', 'Second fresh task'],
      mode: 'sequential',
      model: 'provider/model',
      workspacePath: '/tmp/flow-queue-controller',
      source: 'manual',
      createdAt: 1,
    }
    try {
      await controller.start()
      controller.enqueueQueueInputs(compileFlowQueue(flow), { start: true })
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'First fresh task'), 'the first Flow task')
      expect(controller.getSnapshot().queue.items.some((item) => item.flow?.taskId === 'HW-CONTROL-2')).toBe(true)

      transport.settle()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Second fresh task'), 'the second Flow task')
      const sessions = transport.commands.filter((command) => command.type === 'new_session')
      expect(sessions).toHaveLength(2)
      expect(sessions[0]).toEqual({ type: 'new_session' })
      expect(sessions[1]).toEqual({ type: 'new_session', parentSession: '/tmp/queue-session.jsonl' })
      expect(transport.commands.filter((command) => command.type === 'set_model')).toEqual([
        { type: 'set_model', provider: 'provider', modelId: 'model' },
        { type: 'set_model', provider: 'provider', modelId: 'model' },
      ])
      expect(transport.commands.filter((command) => command.type === 'set_session_name')).toEqual([
        { type: 'set_session_name', name: 'Flow HW-CONTROL/1:2 · Controller flow · Step 1' },
        { type: 'set_session_name', name: 'Flow HW-CONTROL/2:2 · Controller flow · Step 2' },
      ])
    } finally {
      await controller.dispose()
    }
  })


  it('keeps row holds lane-local and stops delivery behind each held head', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-row-holds', testControllerDependencies())
    try {
      await controller.start()
      const [held] = controller.enqueueQueueInputs([
        { text: 'Held steer', lane: 'steer', paused: true },
        { text: 'Next steer', lane: 'steer' },
        { text: 'Independent follow-up', lane: 'followUp' },
      ], { start: true })
      expect(held).toBeDefined()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Independent follow-up')
        && controller.getSnapshot().queue.items.length === 2, 'the independent follow-up lane')
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['Held steer', 'Next steer'])

      transport.settle()
      await Bun.sleep(20)
      expect(transport.commands.filter((command) => command.type === 'prompt' && (command.message === 'Held steer' || command.message === 'Next steer'))).toEqual([])

      controller.toggleQueuedInputPause(held!.id)
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Held steer')
        && controller.getSnapshot().queue.items.length === 1, 'the released steer-lane head')
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['Next steer'])
    } finally {
      await controller.dispose()
    }
  })

  it('holds prewalk controls until Pi Fabric acknowledges the arm without creating transcript context', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-fabric-prewalk', testControllerDependencies())
    try {
      await controller.start()
      await controller.submit('/fabric prewalk')
      const prewalk = controller.getSnapshot().queue.items.find((item) => item.text === '/fabric prewalk')
      controller.queueInput('Continue after prewalk', [], { lane: 'followUp' })
      expect(prewalk).toBeDefined()
      await waitFor(() => controller.getSnapshot().queue.dispatchingId === prewalk!.id, 'the prewalk bridge request')
      const hidden = transport.commands.find((command) => command.type === 'prompt' && String(command.message).startsWith(HEDDLEWORK_FABRIC_BRIDGE_PREFIX))
      expect(hidden).toBeDefined()
      expect(controller.getSnapshot().messages).toEqual([])
      expect(controller.getSnapshot().session.isStreaming).toBe(false)
      expect(controller.getSnapshot().queue).toMatchObject({ blockingActivity: 'fabric-prewalk' })

      controller.acceptAgentEvent(fabricBridgeRecord({ requestId: prewalk!.id, event: 'started', activity: 'prewalk', note: 'prewalk armed by Fabric' }))
      expect(controller.getSnapshot().queue.blockingNote).toBe('prewalk armed by Fabric')
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['/fabric prewalk', 'Continue after prewalk'])

      controller.acceptAgentEvent(fabricBridgeRecord({ requestId: prewalk!.id, event: 'settled', activity: 'prewalk' }))
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && command.message === 'Continue after prewalk'), 'the row after acknowledged prewalk')
      expect(controller.getSnapshot().queue.items).toEqual([])
      expect(controller.getSnapshot().queue.blockingActivity).toBeUndefined()
    } finally {
      await controller.dispose()
    }
  })

  it('uses a local Fabric peer picker and exposes cancellable await progress', async () => {
    const transport = new QueueTransport()
    const controller = new WorkbenchController(transport, '/tmp/queue-fabric-await', testControllerDependencies())
    try {
      await controller.start()
      const picking = controller.queueFabricPeerGate()
      await waitFor(() => transport.commands.some((command) => command.type === 'prompt' && String(command.message).includes('"action":"peers"')), 'the peer projection request')
      const request = transport.commands.find((command) => command.type === 'prompt' && String(command.message).includes('"action":"peers"'))
      expect(request?.type).toBe('prompt')
      const requestPayload = request?.type === 'prompt' ? JSON.parse(String(request.message).slice(HEDDLEWORK_FABRIC_BRIDGE_PREFIX.length)) as { requestId: string } : undefined
      controller.acceptAgentEvent(fabricBridgeRecord({
        requestId: requestPayload!.requestId,
        event: 'peers',
        peers: [{ id: 'peer-review', label: 'Review worker', status: 'running', model: 'provider/model', cwd: '/tmp/project', startedAt: 1, updatedAt: 2, pendingMessages: false }],
      }))
      await picking
      const option = controller.getSnapshot().dialog?.options?.[1]
      expect(option).toContain('Review worker')
      controller.respondToDialog({ value: option! })
      await waitFor(() => Boolean(controller.getSnapshot().queue.blockingActivity), 'the peer settle gate')
      const gate = controller.getSnapshot().queue.items[0]!
      expect(gate.text).toBe('/fabric await peer-review')

      controller.acceptAgentEvent(fabricBridgeRecord({ requestId: gate.id, event: 'progress', activity: 'await', note: 'waiting for Review worker (running)', waiting: [{ label: 'Review worker', status: 'running' }] }))
      expect(controller.getSnapshot().queue).toMatchObject({ blockingActivity: 'fabric-await', blockingNote: 'waiting for Review worker (running)' })
      controller.cancelBlockingQueueActivity()
      expect(controller.getSnapshot().queue).toMatchObject({ items: [], dispatchingId: undefined, blockingActivity: undefined })
      expect(transport.sent.at(-1)?.type).toBe('prompt')
      expect(String(transport.sent.at(-1)?.message)).toContain('"action":"cancel"')
    } finally {
      await controller.dispose()
    }
  })

  it('moves stable rows without mutating the source array', () => {
    expect(parseBuiltinSlashCommand('/compact focus')).toEqual({ name: 'compact', argument: 'focus' })
    expect(parseBuiltinSlashCommand('/model openai/gpt-5')).toEqual({ name: 'model', argument: 'openai/gpt-5' })
    expect(parseBuiltinSlashCommand('/skill:review')).toBeUndefined()
    const rows = ['a', 'b', 'c'].map((id, index) => ({ id, text: id, images: [], createdAt: index }))
    const moved = moveQueuedInput(rows, 'c', 0)
    expect(moved.map((row) => row.id)).toEqual(['c', 'a', 'b'])
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })
})
