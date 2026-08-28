import { describe, expect, it } from 'bun:test'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

class FlakyTransport implements AgentTransport {
  starts = 0
  #statusListeners = new Set<(status: TransportStatus) => void>()

  start(): Promise<void> {
    this.starts += 1
    return Promise.resolve()
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }

  request<T>(_command: RpcCommand): Promise<T> {
    return Promise.resolve({} as T)
  }

  send(_record: RpcRecord): void {}

  onEvent(_listener: (event: RpcRecord) => void): () => void {
    return () => undefined
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.#statusListeners.add(listener)
    return () => this.#statusListeners.delete(listener)
  }

  getStderr(): string {
    return ''
  }

  crash(): void {
    for (const listener of this.#statusListeners) listener({ state: 'exited', message: 'Pi exited (code=1)' })
  }
}

function flushTimerWork(ms = 1_100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('controller auto-reconnect', () => {
  it('reconnects automatically when the Pi process exits unexpectedly', async () => {
    const transport = new FlakyTransport()
    const controller = new WorkbenchController(transport, '/tmp/example-workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      expect(controller.getSnapshot().connection).toBe('connected')

      transport.crash()
      expect(controller.getSnapshot().connection).toBe('error')
      expect(controller.getSnapshot().notices.some((notice) => notice.message.includes('reconnecting automatically'))).toBe(true)

      await flushTimerWork()
      expect(transport.starts).toBe(2)
      expect(controller.getSnapshot().connection).toBe('connected')
    } finally {
      await controller.dispose()
    }
  }, 4_000)

  it('does not schedule reconnects after dispose', async () => {
    const transport = new FlakyTransport()
    const controller = new WorkbenchController(transport, '/tmp/example-workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    await controller.start()
    await controller.dispose()

    transport.crash()
    await flushTimerWork()
    expect(transport.starts).toBe(1)
  }, 4_000)
})