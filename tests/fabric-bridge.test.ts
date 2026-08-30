import { describe, expect, it } from 'bun:test'
import { pathToFileURL } from 'node:url'
import {
  encodeFabricBridgeRequest,
  encodeTreeNavigateBridgeRequest,
  heddleworkFabricBridgePath,
  HEDDLEWORK_FABRIC_BRIDGE_PREFIX,
  HEDDLEWORK_FABRIC_BRIDGE_SOURCE,
  HEDDLEWORK_FABRIC_BRIDGE_WIDGET,
  HEDDLEWORK_TREE_BRIDGE_COMMAND,
  parseFabricBridgeEvent,
  parseTreeNavigateBridgeEvent,
} from '../src/pi/fabric-bridge.ts'
import type { RpcRecord } from '../src/pi/types.ts'

function widgetRecord(value: unknown): RpcRecord {
  return {
    type: 'extension_ui_request',
    id: 'bridge-event',
    method: 'setWidget',
    widgetKey: HEDDLEWORK_FABRIC_BRIDGE_WIDGET,
    widgetLines: [JSON.stringify(value)],
  }
}

describe('Heddlework Pi Fabric bridge', () => {
  it('encodes hidden RPC input and validates structured widget events', () => {
    const input = encodeFabricBridgeRequest({ action: 'await', requestId: 'gate-1', peer: 'reviewer' })
    expect(input.startsWith(HEDDLEWORK_FABRIC_BRIDGE_PREFIX)).toBe(true)
    expect(JSON.parse(input.slice(HEDDLEWORK_FABRIC_BRIDGE_PREFIX.length))).toEqual({ action: 'await', requestId: 'gate-1', peer: 'reviewer' })
    expect(parseFabricBridgeEvent(widgetRecord({ version: 1, requestId: 'gate-1', event: 'progress', activity: 'await', note: 'waiting', waiting: [{ label: 'reviewer', status: 'running' }] }))).toEqual({
      version: 1,
      requestId: 'gate-1',
      event: 'progress',
      activity: 'await',
      note: 'waiting',
      waiting: [{ label: 'reviewer', status: 'running' }],
    })
    expect(parseFabricBridgeEvent(widgetRecord({ version: 1, requestId: 'gate-1', event: 'progress', activity: 'await', note: 'waiting', waiting: [{ label: 'reviewer', status: 'invalid' }] }))).toBeUndefined()

    const treeCommand = encodeTreeNavigateBridgeRequest({ requestId: 'tree-1', targetId: 'entry-1', summarize: true })
    expect(treeCommand.startsWith(`/${HEDDLEWORK_TREE_BRIDGE_COMMAND} `)).toBe(true)
    expect(JSON.parse(treeCommand.slice(treeCommand.indexOf(' ') + 1))).toEqual({ requestId: 'tree-1', targetId: 'entry-1', summarize: true })
    expect(parseTreeNavigateBridgeEvent(widgetRecord({ version: 1, requestId: 'tree-1', event: 'tree_navigated', cancelled: false, editorText: 'Try another path' }))).toEqual({
      version: 1,
      requestId: 'tree-1',
      event: 'tree_navigated',
      cancelled: false,
      editorText: 'Try another path',
    })
  })

  it('materializes a control-only extension with no model tools or transcript messages', () => {
    const path = heddleworkFabricBridgePath(`/tmp/heddlework-bridge-test-${process.pid}`)
    expect(path.endsWith('pi-fabric-bridge-v1.mjs')).toBe(true)
    expect(Bun.file(path).size).toBeGreaterThan(1_000)
    expect(HEDDLEWORK_FABRIC_BRIDGE_SOURCE).toContain('pi.on("input"')
    expect(HEDDLEWORK_FABRIC_BRIDGE_SOURCE).toContain('action: "handled"')
    expect(HEDDLEWORK_FABRIC_BRIDGE_SOURCE).not.toContain('registerTool')
    expect(HEDDLEWORK_FABRIC_BRIDGE_SOURCE).toContain('registerCommand(TREE_COMMAND')
    expect(HEDDLEWORK_FABRIC_BRIDGE_SOURCE).toContain('ctx.navigateTree')
    expect(HEDDLEWORK_FABRIC_BRIDGE_SOURCE).not.toContain('sendMessage')
  })

  it('intercepts controls and calls public Fabric protocols without starting model turns', async () => {
    const path = heddleworkFabricBridgePath(`/tmp/heddlework-bridge-runtime-${process.pid}`)
    const extension = (await import(`${pathToFileURL(path).href}?test=${Date.now()}`)).default as (pi: Record<string, unknown>) => void
    const handlers = new Map<string, (event: Record<string, unknown>, context: Record<string, unknown>) => unknown>()
    const commands = new Map<string, (args: string, context: Record<string, unknown>) => Promise<void>>()
    const protocolCalls: Array<{ event: string; request: Record<string, unknown> }> = []
    const navigations: Array<{ targetId: string; options: Record<string, unknown> }> = []
    const widgets: Array<{ key: string; lines: string[] }> = []
    const context = {
      ui: { setWidget: (key: string, lines: string[]) => widgets.push({ key, lines }) },
      sessionManager: {
        getLeafId: () => 'assistant-1',
        getEntry: (id: string) => id === 'user-1' ? { type: 'message', id, parentId: null, message: { role: 'user', content: 'Try another path' } } : undefined,
      },
      navigateTree: async (targetId: string, options: Record<string, unknown>) => {
        navigations.push({ targetId, options })
        return { cancelled: false }
      },
    }
    const pi = {
      on: (event: string, handler: (payload: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) => handlers.set(event, handler),
      registerCommand: (name: string, command: { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }) => commands.set(name, command.handler),
      events: {
        emit: (event: string, request: Record<string, unknown>) => {
          protocolCalls.push({ event, request })
          expect((request.claim as () => boolean)()).toBe(true)
          if (event === 'pi-fabric:prewalk:request:v1') (request.respond as (value: unknown) => void)({ ok: true, armed: true })
          if (event === 'pi-fabric:peers:cards:v1') (request.respond as (value: unknown) => void)({ ok: true, cards: [{ id: 'peer-1', label: 'Reviewer', status: 'idle', startedAt: 1, updatedAt: 2, pendingMessages: false }] })
          if (event === 'pi-fabric:peer:await-settle:v1') {
            const update = request.update as (value: unknown) => void
            update({ waiting: [{ id: 'peer-1', label: 'Reviewer', status: 'running', updatedAt: 2 }] })
            const signal = request.signal as AbortSignal
            signal.addEventListener('abort', () => (request.respond as (value: unknown) => void)({ ok: false, error: 'aborted' }), { once: true })
          }
        },
      },
    }
    extension(pi)
    const input = handlers.get('input')!

    await commands.get(HEDDLEWORK_TREE_BRIDGE_COMMAND)!(JSON.stringify({ requestId: 'tree-1', targetId: 'user-1', summarize: true }), context)
    expect(navigations).toEqual([{ targetId: 'user-1', options: { summarize: true } }])
    expect(JSON.parse(widgets.at(-1)!.lines[0]!)).toMatchObject({ requestId: 'tree-1', event: 'tree_navigated', cancelled: false, editorText: 'Try another path' })

    widgets.length = 0
    expect(input({ source: 'rpc', text: encodeFabricBridgeRequest({ action: 'prewalk', requestId: 'prewalk-1' }) }, context)).toEqual({ action: 'handled' })
    await Bun.sleep(0)
    expect(protocolCalls[0]?.event).toBe('pi-fabric:prewalk:request:v1')
    expect(widgets.map(({ lines }) => JSON.parse(lines[0]!).event)).toEqual(['started', 'settled'])

    widgets.length = 0
    expect(input({ source: 'rpc', text: encodeFabricBridgeRequest({ action: 'peers', requestId: 'peers-1' }) }, context)).toEqual({ action: 'handled' })
    await Bun.sleep(0)
    expect(JSON.parse(widgets.at(-1)!.lines[0]!)).toMatchObject({ event: 'peers', peers: [{ id: 'peer-1', label: 'Reviewer' }] })

    widgets.length = 0
    input({ source: 'rpc', text: encodeFabricBridgeRequest({ action: 'await', requestId: 'await-1', peer: 'peer-1' }) }, context)
    await Bun.sleep(0)
    expect(protocolCalls.at(-1)?.event).toBe('pi-fabric:peer:await-settle:v1')
    expect(widgets.map(({ lines }) => JSON.parse(lines[0]!).event)).toEqual(['progress', 'started'])
    input({ source: 'rpc', text: encodeFabricBridgeRequest({ action: 'cancel', requestId: 'cancel-1', targetId: 'await-1' }) }, context)
    await Bun.sleep(0)
    expect(JSON.parse(widgets.at(-1)!.lines[0]!)).toMatchObject({ requestId: 'await-1', event: 'cancelled' })
    expect(input({ source: 'interactive', text: '/fabric await peer-1' }, context)).toEqual({ action: 'continue' })
  })
})
