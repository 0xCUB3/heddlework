import { afterEach, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchController } from '../src/workbench/controller.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { RpcCommand, RpcRecord } from '../src/pi/types.ts'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'heddlework-open-')); directories.push(dir)
  const sessions: PiSessionSummary[] = []
  for (const id of ['a', 'b', 'c']) {
    const path = join(dir, `${id}.jsonl`)
    const records = [{ type: 'session', version: 3, id, cwd: dir, timestamp: new Date().toISOString() }, ...Array.from({ length: 100 }, (_, i) => ({ type: 'message', id: `${id}-${i}`, parentId: i ? `${id}-${i - 1}` : null, message: { role: i % 2 ? 'assistant' : 'user', content: `${id} message ${i}`, timestamp: i } }))]
    await writeFile(path, records.map(x => JSON.stringify(x)).join('\n') + '\n')
    sessions.push({ id, path, cwd: dir, title: id, firstMessage: `${id} message 0`, messageCount: 100, createdAt: 1, modifiedAt: 1 })
  }
  const transport = new SlowSwitchTransport(sessions)
  const controller = new WorkbenchController(transport, dir, {
    sessionCatalog: { list: async () => sessions, createWorkspaceSession: async () => sessions[0]! },
    workspaceDiff: { load: async () => ({ status: 'ready', branch: '', files: [], additions: 0, deletions: 0 }) },
  })
  await controller.start()
  return { controller, transport, sessions }
}
class SlowSwitchTransport implements AgentTransport {
  active: PiSessionSummary
  requests: RpcCommand[] = []
  switchGate: ReturnType<typeof deferred> | undefined
  metadataGate: ReturnType<typeof deferred> | undefined
  cancel = false
  fail = false
  constructor(readonly sessions: PiSessionSummary[]) { this.active = sessions[0]! }
  async start() {}
  async stop() {}
  send(_: RpcRecord) {}
  getStderr() { return '' }
  onEvent(_: (event: RpcRecord) => void) { return () => {} }
  onStatus(_: (event: TransportStatus) => void) { return () => {} }
  async request<T>(command: RpcCommand): Promise<T> {
    this.requests.push(command)
    if (command.type === 'switch_session') {
      await this.switchGate?.promise
      if (this.fail) throw new Error('switch rejected')
      if (!this.cancel) this.active = this.sessions.find(s => s.path === command.sessionPath)!
      return { cancelled: this.cancel } as T
    }
    if (command.type === 'get_state') return { model: null, thinkingLevel: 'off', isStreaming: false, sessionFile: this.active.path, sessionId: this.active.id } as T
    if (command.type === 'get_tree') return { tree: [], leafId: `${this.active.id}-99` } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_commands') { const id = this.active.id; await this.metadataGate?.promise; return { commands: [{ name: `command-${id}`, description: id, source: 'extension' }] } as T }
    return undefined as T
  }
}
async function until(predicate: () => boolean) {
  const end = performance.now() + 1000
  while (!predicate()) { if (performance.now() > end) throw Error('Timed out waiting for transcript'); await Bun.sleep(1) }
}
it('renders a bounded disk preview while Pi is blocked, without sending to the old session', async () => {
  const { controller, transport, sessions } = await fixture()
  const gate = transport.switchGate = deferred()
  try {
    const switching = controller.switchSession(sessions[1]!)
    expect(controller.getSnapshot().session.sessionFile).toBe(sessions[1]!.path)
    expect(controller.getSnapshot().connection).toBe('connecting')
    await until(() => controller.getSnapshot().messages.at(-1)?.content === 'b message 99')
    expect(transport.active.id).toBe('a')
    expect(controller.getSnapshot().messages).toHaveLength(80)
    await controller.submit('must not go to a')
    await controller.newSession()
    await controller.setThinkingLevel('high')
    await controller.loadEarlierMessages()
    expect(transport.requests.some(r => ['prompt', 'new_session', 'set_thinking_level'].includes(r.type))).toBe(false)
    gate.resolve(); await switching
    expect(controller.getSnapshot().connection).toBe('connected')
    expect(controller.getSnapshot().messagesHasOlder).toBe(true)
    await controller.loadEarlierMessages()
    expect(controller.getSnapshot().messages).toHaveLength(100)
  } finally { gate.resolve(); await controller.dispose() }
})
it('coalesces rapid selections and never paints an intermediate activation over the last click', async () => {
  const { controller, transport, sessions } = await fixture()
  const gate = transport.switchGate = deferred()
  try {
    const first = controller.switchSession(sessions[1]!)
    await until(() => transport.requests.some(r => r.type === 'switch_session'))
    const intermediate = controller.switchSession(sessions[0]!)
    const last = controller.switchSession(sessions[2]!)
    await until(() => controller.getSnapshot().messages.at(-1)?.content === 'c message 99')
    const shown: string[] = []
    const unsubscribe = controller.subscribe(() => shown.push(controller.getSnapshot().session.sessionFile!))
    gate.resolve(); await Promise.all([first, intermediate, last]); unsubscribe()
    expect(shown.every(path => path === sessions[2]!.path)).toBe(true)
    expect(transport.requests.filter(r => r.type === 'switch_session').map(r => r.sessionPath)).toEqual([sessions[1]!.path, sessions[2]!.path])
    expect(transport.active.id).toBe('c')
  } finally { gate.resolve(); await controller.dispose() }
})
for (const failure of ['cancel', 'fail'] as const) it(`restores the committed transcript and draft after ${failure}`, async () => {
  const { controller, transport, sessions } = await fixture()
  try {
    controller.setEditorText('keep this draft')
    transport[failure] = true
    await controller.switchSession(sessions[1]!)
    expect(controller.getSnapshot().session.sessionFile).toBe(sessions[0]!.path)
    expect(controller.getSnapshot().messages.at(-1)?.content).toBe('a message 99')
    expect(controller.getSnapshot().editorText).toBe('keep this draft')
  } finally { await controller.dispose() }
})
it('slow optional commands do not block activation and stale metadata cannot overwrite the next session', async () => {
  const { controller, transport, sessions } = await fixture()
  const gate = transport.metadataGate = deferred()
  try {
    await Promise.race([controller.switchSession(sessions[1]!), Bun.sleep(500).then(() => { throw Error('commands blocked activation') })])
    expect(controller.getSnapshot().connection).toBe('connected')
    transport.metadataGate = undefined
    await controller.switchSession(sessions[2]!)
    await until(() => controller.getSnapshot().commands.some(c => c.name === 'command-c'))
    gate.resolve(); await Bun.sleep(10)
    expect(controller.getSnapshot().commands.some(c => c.name === 'command-b')).toBe(false)
  } finally { gate.resolve(); await controller.dispose() }
})
