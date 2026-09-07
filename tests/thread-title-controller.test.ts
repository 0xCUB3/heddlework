import { describe, expect, it } from 'bun:test'
import type { HarnessAdapter, HarnessCapabilities } from '../src/pi/transport.ts'
import type { PiMessage, PiSessionState, RpcRecord } from '../src/pi/types.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { WorkbenchController, type ThreadTitleGeneratorService } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

// Minimal harness: one session with a file path and a model, so the auto-title guards have something to look at.
class TitleTransport implements HarnessAdapter {
  readonly id = 'title-test'
  readonly displayName = 'Title test'
  readonly capabilities: HarnessCapabilities = { steering: true, followUp: true, compaction: false, forking: false, treeNavigation: false, sessionSwitching: true, sessionNaming: true, extensionUi: false } as HarnessCapabilities
  readonly listeners = new Set<(event: RpcRecord) => void>()
  readonly requests: RpcRecord[] = []
  sessionName: string | undefined
  messages: PiMessage[] = []
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onEvent(listener: (event: RpcRecord) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onStatus(): () => void { return () => undefined }
  send(): void {}
  emit(event: RpcRecord): void { for (const listener of this.listeners) listener(event) }
  async request<T>(command: RpcRecord): Promise<T> {
    this.requests.push(command)
    switch (command.type) {
      case 'get_state': return { model: { provider: 'demo', id: 'big' }, thinkingLevel: 'off', isStreaming: false, sessionId: 'title', sessionFile: '/tmp/title-session.jsonl', ...(this.sessionName ? { sessionName: this.sessionName } : {}) } satisfies PiSessionState as T
      case 'get_messages': return { messages: this.messages } as T
      case 'get_available_models': return { models: [{ provider: 'demo', id: 'big' }, { provider: 'demo', id: 'small' }] } as T
      case 'get_thinking_levels': return { levels: ['off'] } as T
      case 'get_commands': return { commands: [] } as T
      case 'set_session_name': this.sessionName = String(command.name); return undefined as T
      default: return undefined as T
    }
  }
}

function fakeGenerator(title: string | Error): ThreadTitleGeneratorService & { calls: { model: string; context: string; previousTitle?: string | undefined }[] } {
  const calls: { model: string; context: string; previousTitle?: string | undefined }[] = []
  return {
    calls,
    async generate(request) {
      calls.push({ model: request.model, context: request.context, previousTitle: request.previousTitle })
      if (title instanceof Error) throw title
      return title
    },
  }
}

async function settle(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 20)) }

async function boot(transport: TitleTransport, generator: ThreadTitleGeneratorService | undefined, settings?: { autoTitles?: boolean; titleModel?: string }) {
  const controller = new WorkbenchController(transport, '/tmp/title-workspace', {
    ...testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })),
    ...(generator ? { titleGenerator: generator } : {}),
    ...(settings ? { titleSettingsStore: { load: () => ({ autoTitles: true, ...settings }), save: () => undefined } } : {}),
  })
  await controller.start()
  return controller
}

describe('thread titles in the controller', () => {
  it('titles an unnamed thread once its first turn settles and records the source', async () => {
    const transport = new TitleTransport()
    transport.messages = [{ role: 'user', content: 'Fix the login redirect loop on mobile Safari' }, { role: 'assistant', content: 'On it' }]
    const generator = fakeGenerator('Mobile Safari login redirect loop')
    const controller = await boot(transport, generator)
    try {
      transport.emit({ type: 'agent_settled' })
      await settle()
      expect(generator.calls).toHaveLength(1)
      expect(generator.calls[0]?.model).toBe('demo/big')
      expect(generator.calls[0]?.context).toContain('USER:\nFix the login redirect loop')
      expect(transport.sessionName).toBe('Mobile Safari login redirect loop')
      const snapshot = controller.getSnapshot()
      expect(snapshot.session.sessionName).toBe('Mobile Safari login redirect loop')
      expect(snapshot.threadLifecycle['/tmp/title-session.jsonl']).toEqual({ titleSource: 'auto' })
      transport.emit({ type: 'agent_settled' })
      await settle()
      expect(generator.calls).toHaveLength(1)
    } finally {
      await controller.dispose()
    }
  })

  it('leaves a manually named thread alone and respects the off switch', async () => {
    const named = new TitleTransport()
    named.sessionName = 'Mine'
    named.messages = [{ role: 'user', content: 'hello' }]
    const generator = fakeGenerator('Should not apply')
    const controller = await boot(named, generator)
    try {
      named.emit({ type: 'agent_settled' })
      await settle()
      expect(generator.calls).toHaveLength(0)
    } finally {
      await controller.dispose()
    }
    const off = new TitleTransport()
    off.messages = [{ role: 'user', content: 'hello' }]
    const offController = await boot(off, generator, { autoTitles: false })
    try {
      off.emit({ type: 'agent_settled' })
      await settle()
      expect(generator.calls).toHaveLength(0)
      expect(offController.getSnapshot().threadTitles).toEqual({ autoTitles: false })
    } finally {
      await offController.dispose()
    }
  })

  it('regenerates on request with the previous title, uses the configured model, and reports failures', async () => {
    const transport = new TitleTransport()
    transport.sessionName = 'Old name'
    transport.messages = [{ role: 'user', content: 'first ask' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'now something else' }]
    const generator = fakeGenerator('Fresh name')
    const controller = await boot(transport, generator, { titleModel: 'xai/grok-3-mini' })
    try {
      await controller.renameThread('Hand picked')
      expect(controller.getSnapshot().threadLifecycle['/tmp/title-session.jsonl']?.titleSource).toBe('manual')
      await controller.regenerateThreadTitle('/tmp/title-session.jsonl')
      expect(generator.calls[0]).toMatchObject({ model: 'xai/grok-3-mini', previousTitle: 'Hand picked' })
      expect(generator.calls[0]?.context).toContain('now something else')
      expect(transport.sessionName).toBe('Fresh name')
      expect(controller.getSnapshot().threadLifecycle['/tmp/title-session.jsonl']).toEqual({ titleSource: 'auto' })
    } finally {
      await controller.dispose()
    }
    const failing = new TitleTransport()
    failing.messages = [{ role: 'user', content: 'x' }]
    const broken = await boot(failing, fakeGenerator(new Error('model offline')))
    try {
      await broken.regenerateThreadTitle('/tmp/title-session.jsonl')
      expect(broken.getSnapshot().notices.some((notice) => notice.message.includes('model offline'))).toBe(true)
      expect(broken.getSnapshot().threadLifecycle['/tmp/title-session.jsonl']?.titleGeneratingAt).toBeUndefined()
    } finally {
      await broken.dispose()
    }
  })

  it('persists settings changes through the store', async () => {
    const saved: unknown[] = []
    const transport = new TitleTransport()
    const controller = new WorkbenchController(transport, '/tmp/title-workspace', {
      ...testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })),
      titleSettingsStore: { load: () => ({ autoTitles: true }), save: (settings) => { saved.push(settings) } },
    })
    try {
      controller.setThreadTitleSettings({ titleModel: ' anthropic/claude-haiku-4-5 ' })
      controller.setThreadTitleSettings({ autoTitles: false })
      expect(saved).toEqual([{ autoTitles: true, titleModel: 'anthropic/claude-haiku-4-5' }, { autoTitles: false, titleModel: 'anthropic/claude-haiku-4-5' }])
      expect(controller.getSnapshot().threadTitles).toEqual({ autoTitles: false, titleModel: 'anthropic/claude-haiku-4-5' })
    } finally {
      await controller.dispose()
    }
  })
})
