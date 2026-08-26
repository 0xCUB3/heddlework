import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { PiRpcTransport } from '../src/pi/rpc-transport.ts'
import type { RpcRecord } from '../src/pi/types.ts'

describe('PiRpcTransport', () => {
  it('correlates responses while forwarding interleaved events', async () => {
    const events: RpcRecord[] = []
    const transport = new PiRpcTransport({
      cwd: process.cwd(),
      command: process.execPath,
      commandArgs: [resolve(import.meta.dir, 'fixtures/fake-pi.ts')],
    })
    const unsubscribe = transport.onEvent((event) => events.push(event))
    try {
      await transport.start()
      await expect(transport.request<{ pong: boolean }>({ type: 'ping' })).resolves.toEqual({ pong: true })
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('queue_update')
      expect((events[0]?.steering as string[])[0]).toBe('hello\u2028world')
      await expect(transport.request({ type: 'fail' })).rejects.toThrow('expected failure')
    } finally {
      unsubscribe()
      await transport.stop()
    }
  })
})
