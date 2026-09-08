import { describe, expect, it } from 'bun:test'
import { RemoteWorkbenchController } from '../src/dom/remote-controller.ts'
import type { TranscriptDetail, WorkbenchCommand, WorkbenchSnapshot } from '../src/protocol/index.ts'
import type { WorkspaceClient, WorkspaceClientView } from '../src/web/client.ts'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { createInitialState } from '../src/workbench/state.ts'

class Deferred<T> {
  promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (error: Error) => void
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

class FakeWorkspaceClient {
  readonly commands: WorkbenchCommand[] = []
  readonly listeners = new Set<() => void>()
  view: WorkspaceClientView
  #pending = new Map<string, Deferred<unknown>>()

  constructor(state: WorkbenchSnapshot) {
    this.view = { status: 'open', workspacePath: '/tmp', state, flows: undefined }
  }

  getSnapshot(): WorkspaceClientView {
    return this.view
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  push(state: WorkbenchSnapshot): void {
    this.view = { ...this.view, state }
    for (const listener of this.listeners) listener()
  }
  send(command: WorkbenchCommand): Promise<unknown> {
    this.commands.push(command)
    const deferred = new Deferred<unknown>()
    this.#pending.set(`${command.type}:${this.commands.length}`, deferred)
    this.lastDeferred = deferred
    return deferred.promise
  }
  lastDeferred: Deferred<unknown> | undefined
  sendAndReport(command: WorkbenchCommand): Promise<void> {
    return this.send(command).then(() => undefined, () => undefined)
  }
  async getTranscriptDetail(entryId: string): Promise<TranscriptDetail> {
    return this.send({ type: 'getTranscriptDetail', entryId }) as Promise<TranscriptDetail>
  }
  reportError(_error: unknown): void {}
  reconnect(): void {}
}

function snapshot(path: string, title: string, messages: WorkbenchSnapshot['messages'], extra: Partial<WorkbenchSnapshot> = {}): WorkbenchSnapshot {
  const base = createInitialState('/tmp')
  return {
    ...base,
    connection: 'connected',
    connectionMessage: 'Connected',
    activity: extra.activity ?? 'Ready',
    session: { ...base.session, sessionFile: path, sessionId: title, sessionName: title, isStreaming: false },
    messages,
    messagesHasOlder: false,
    ...extra,
  } as WorkbenchSnapshot
}

const alpha: PiSessionSummary = { id: 'alpha', path: '/tmp/alpha.jsonl', cwd: '/tmp', title: 'Alpha', firstMessage: 'A', messageCount: 1, createdAt: 1, modifiedAt: 1 }
const beta: PiSessionSummary = { id: 'beta', path: '/tmp/beta.jsonl', cwd: '/tmp', title: 'Beta', firstMessage: 'B', messageCount: 1, createdAt: 2, modifiedAt: 2 }
const gamma: PiSessionSummary = { id: 'gamma', path: '/tmp/gamma.jsonl', cwd: '/tmp', title: 'Gamma', firstMessage: 'G', messageCount: 1, createdAt: 3, modifiedAt: 3 }

describe('remote session navigation races', () => {
  it('keeps the newest selection and ignores a late older snapshot', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', [{ role: 'user', content: 'Alpha prompt', timestamp: 1, workbenchEntryId: 'a1' }]))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    const first = remote.switchSession(beta)
    expect(remote.getSnapshot().activity).toBe('Opening thread')
    expect(remote.getSnapshot().session.sessionFile).toBe(beta.path)
    void remote.switchSession(alpha)
    expect(remote.getSnapshot().session.sessionFile).toBe(alpha.path)
    client.push(snapshot(beta.path, 'Beta', [{ role: 'user', content: 'LATE_BETA', timestamp: 9, workbenchEntryId: 'b-late' }], { activity: 'Ready' }))
    expect(remote.getSnapshot().messages.some((message) => String(message.content).includes('LATE_BETA'))).toBe(false)
    expect(remote.getSnapshot().session.sessionFile).toBe(alpha.path)
    client.push(snapshot(alpha.path, 'Alpha', [{ role: 'user', content: 'Alpha restored', timestamp: 2, workbenchEntryId: 'a2' }], { activity: 'Ready' }))
    expect(remote.getSnapshot().messages[0]?.content).toBe('Alpha restored')
    expect(remote.getSnapshot().activity).not.toBe('Opening thread')
    client.lastDeferred?.resolve(undefined)
    await first.catch(() => undefined)
  })

  it('does not replace cached messages with an empty Opening snapshot', async () => {
    const cached = snapshot(beta.path, 'Beta', [
      { role: 'user', content: 'Cached beta', timestamp: 1, workbenchEntryId: 'b1' },
      { role: 'assistant', content: 'Cached answer', timestamp: 2, workbenchEntryId: 'b2' },
    ])
    const client = new FakeWorkspaceClient(cached)
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    expect(remote.getSnapshot().messages).toHaveLength(2)
    const switching = remote.switchSession(beta)
    client.push(snapshot(beta.path, 'Beta', [], { connection: 'connecting', activity: 'Opening thread' }))
    expect(remote.getSnapshot().messages.map((message) => message.content)).toEqual(['Cached beta', 'Cached answer'])
    client.push(snapshot(beta.path, 'Beta', [
      { role: 'user', content: 'Cached beta', timestamp: 1, workbenchEntryId: 'b1' },
      { role: 'assistant', content: 'Cached answer', timestamp: 2, workbenchEntryId: 'b2' },
    ], { activity: 'Ready', connection: 'connected' }))
    expect(remote.getSnapshot().activity).toBe('Ready')
    expect(remote.getSnapshot().messages).toHaveLength(2)
    await Promise.resolve()
    client.lastDeferred?.resolve(undefined)
    await switching
  })

  it('clears Opening thread on a failed switch instead of leaving the composer stuck', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', [{ role: 'user', content: 'Alpha', timestamp: 1, workbenchEntryId: 'a1' }]))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    const switching = remote.switchSession(beta)
    expect(remote.getSnapshot().activity).toBe('Opening thread')
    await Promise.resolve()
    expect(client.commands.at(-1)?.type).toBe('switchSession')
    client.lastDeferred?.reject(new Error('offline'))
    await switching
    expect(remote.getSnapshot().activity).toBe('Ready')
    expect(remote.getSnapshot().connection).toBe('error')
    expect(remote.getSnapshot().session.sessionFile).toBe(beta.path)
  })

  it('does not retry a failed session switch when the host publishes the still-current thread', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', [{ role: 'user', content: 'Alpha', timestamp: 1, workbenchEntryId: 'a1' }]))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    const switching = remote.switchSession(beta)
    await Promise.resolve()
    client.lastDeferred?.reject(new Error('offline'))
    await switching
    expect(client.commands).toHaveLength(1)

    client.push(snapshot(alpha.path, 'Alpha', [{ role: 'user', content: 'Alpha current', timestamp: 2, workbenchEntryId: 'a2' }]))
    expect(client.commands).toHaveLength(1)
    expect(remote.getSnapshot().session.sessionFile).toBe(alpha.path)
  })

  it('drops in-flight detail when the selected session changes', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', [{
      role: 'assistant',
      workbenchEntryId: 'a-big',
      content: 'preview…',
      timestamp: 1,
      detailRef: { entryId: 'a-big', bytes: 12_000, omitted: true as const },
    }]))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    const detail = remote.getTranscriptDetail('a-big')
    const switching = remote.switchSession(beta)
    client.lastDeferred?.resolve({
      kind: 'message',
      entryId: 'a-big',
      offset: 0,
      complete: true,
      totalBytes: 12,
      encoding: 'json',
      chunk: '{}',
      bytes: 2,
      sessionFile: alpha.path,
      message: { role: 'assistant', workbenchEntryId: 'a-big', content: 'STALE_FULL', timestamp: 1 },
    } satisfies TranscriptDetail)
    await expect(detail).rejects.toThrow(/Session changed/)
    expect(remote.getSnapshot().messages.some((message) => String(message.content).includes('STALE_FULL'))).toBe(false)
    client.lastDeferred?.resolve(undefined)
    await switching.catch(() => undefined)
  })

  it('applies session catalog patches without rebinding the selected thread', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', [{ role: 'user', content: 'Alpha', timestamp: 1, workbenchEntryId: 'a1' }], { sessions: [alpha, beta] }))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    const switching = remote.switchSession(beta)
    await Promise.resolve()
    client.lastDeferred?.resolve(undefined)
    client.push(snapshot(beta.path, 'Beta', [{ role: 'user', content: 'Beta prompt', timestamp: 2, workbenchEntryId: 'b1' }], {
      sessions: [alpha, beta],
      activity: 'Ready',
      connection: 'connected',
    }))
    await switching
    expect(remote.getSnapshot().session.sessionFile).toBe(beta.path)
    const renamed = { ...alpha, title: 'Renamed elsewhere', modifiedAt: 99 }
    client.push(snapshot(beta.path, 'Beta', remote.getSnapshot().messages, {
      sessions: [renamed, beta],
      activity: 'Ready',
      connection: 'connected',
    }))
    expect(remote.getSnapshot().session.sessionFile).toBe(beta.path)
    expect(remote.getSnapshot().activity).toBe('Ready')
    expect(remote.getSnapshot().sessions.find((session) => session.id === 'alpha')?.title).toBe('Renamed elsewhere')
  })

  it('accepts the new session produced by newSession instead of navigating back to the old selection', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', [{ role: 'user', content: 'Alpha', timestamp: 1, workbenchEntryId: 'a1' }]))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    const creating = remote.newSession()
    await Promise.resolve()
    const command = client.lastDeferred
    expect(client.commands).toEqual([{ type: 'newSession' }])

    const gammaPath = '/tmp/gamma.jsonl'
    client.push(snapshot(gammaPath, 'Gamma', [], { activity: 'Ready', connection: 'connected' }))
    expect(remote.getSnapshot().session.sessionFile).toBe(gammaPath)
    expect(client.commands).toEqual([{ type: 'newSession' }])

    client.push(snapshot(alpha.path, 'Alpha', [{ role: 'user', content: 'LATE_ALPHA', timestamp: 3, workbenchEntryId: 'a-late' }]))
    expect(remote.getSnapshot().session.sessionFile).toBe(gammaPath)
    expect(remote.getSnapshot().messages.some((message) => String(message.content).includes('LATE_ALPHA'))).toBe(false)

    command?.resolve(undefined)
    await creating
  })

  it('cancels a pending editor debounce on dispose', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', []))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    remote.setEditorText('must-not-send')
    await remote.dispose()
    await Bun.sleep(300)
    expect(client.commands).toEqual([])
  })

  it('flushes an Alpha draft before switching to Beta instead of sending it into Beta later', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', []))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    remote.setEditorText('alpha draft')
    const switching = remote.switchSession(beta)
    await Promise.resolve()
    expect(client.commands.slice(0, 2)).toEqual([
      { type: 'setEditorText', text: 'alpha draft' },
      { type: 'switchSession', path: beta.path },
    ])
    expect(remote.getSnapshot().editorText).toBe('')
    client.lastDeferred?.resolve(undefined)
    await switching
    await Bun.sleep(300)
    expect(client.commands.filter((command) => command.type === 'setEditorText')).toEqual([{ type: 'setEditorText', text: 'alpha draft' }])
  })

  it('cancels a pending editor debounce when submitting so submitted text does not reappear', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', []))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    remote.setEditorText('submit me')
    const submitted = remote.submit('submit me')
    await Promise.resolve()
    expect(client.commands).toEqual([{ type: 'submit', text: 'submit me' }])
    client.lastDeferred?.resolve(undefined)
    await submitted
    await Bun.sleep(300)
    expect(client.commands).toEqual([{ type: 'submit', text: 'submit me' }])
  })

  it('does not send a command delayed behind selection after dispose', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', []))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    const switching = remote.switchSession(beta)
    await Promise.resolve()
    const switchDeferred = client.lastDeferred
    void remote.loadEarlierMessages()
    await remote.dispose()
    switchDeferred?.resolve(undefined)
    await switching
    await Promise.resolve()
    expect(client.commands).toEqual([{ type: 'switchSession', path: beta.path }])
  })

  it('never flushes a Beta draft into Alpha while Beta selection is still pending and then superseded by Gamma', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', []))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    const selectingBeta = remote.switchSession(beta)
    await Promise.resolve()
    const betaDeferred = client.lastDeferred

    remote.setEditorText('beta draft')
    const selectingGamma = remote.switchSession(gamma)
    await Bun.sleep(300)
    expect(client.commands.filter((command) => command.type === 'setEditorText')).toEqual([])

    betaDeferred?.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(client.commands.at(-1)).toEqual({ type: 'switchSession', path: gamma.path })
    const gammaDeferred = client.lastDeferred
    gammaDeferred?.resolve(undefined)
    await Promise.all([selectingBeta, selectingGamma])
    expect(client.commands.filter((command) => command.type === 'setEditorText')).toEqual([])

    const backToBeta = remote.switchSession(beta)
    expect(remote.getSnapshot().editorText).toBe('beta draft')
    await Promise.resolve()
    client.lastDeferred?.resolve(undefined)
    await backToBeta
  })

  it('drops a debounce that fires behind a pending selection once a newer selection supersedes it', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', []))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    const selectingBeta = remote.switchSession(beta)
    await Promise.resolve()
    const betaDeferred = client.lastDeferred
    remote.setEditorText('beta pending')

    await Bun.sleep(275)
    const selectingGamma = remote.switchSession(gamma)
    betaDeferred?.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    const gammaDeferred = client.lastDeferred
    gammaDeferred?.resolve(undefined)
    await Promise.all([selectingBeta, selectingGamma])
    expect(client.commands.filter((command) => command.type === 'setEditorText')).toEqual([])
  })

  it('clears the visible Alpha draft before newSession so it cannot appear in the created thread', async () => {
    const client = new FakeWorkspaceClient(snapshot(alpha.path, 'Alpha', []))
    const remote = new RemoteWorkbenchController(client as unknown as WorkspaceClient)
    remote.setEditorText('alpha draft')
    const creating = remote.newSession()
    await Promise.resolve()
    expect(client.commands.slice(0, 2)).toEqual([
      { type: 'setEditorText', text: 'alpha draft' },
      { type: 'newSession' },
    ])
    expect(remote.getSnapshot().editorText).toBe('')
    client.push(snapshot(gamma.path, 'Gamma', [], { editorText: '', activity: 'Ready', connection: 'connected' }))
    expect(remote.getSnapshot().editorText).toBe('')
    client.lastDeferred?.resolve(undefined)
    await creating
  })
})
