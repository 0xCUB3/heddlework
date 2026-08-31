import { describe, expect, it } from 'bun:test'
import { MemoryTerminalBackend, type TerminalBackend, type TerminalProcess } from '../src/terminal/backend.ts'
import type { TerminalProcessStatus, TerminalSpawnRequest } from '../src/terminal/types.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'

const ESC = String.fromCharCode(27)

class PushTerminalBackend implements TerminalBackend {
  readonly writes: Array<string | Uint8Array> = []
  #dataListener: ((chunk: Uint8Array) => void) | undefined

  async spawn(_request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess> {
    const writes = this.writes
    return {
      write(data) { writes.push(data) },
      resize() {},
      kill() {},
      onData: (listener) => {
        this.#dataListener = listener
        return () => { if (this.#dataListener === listener) this.#dataListener = undefined }
      },
      onExit(_listener: (status: TerminalProcessStatus) => void) { return () => {} },
    }
  }

  emit(data: string): void {
    this.#dataListener?.(new TextEncoder().encode(data))
  }
}

describe('TerminalSessionService', () => {
  it('spawns, writes, resizes, and keeps sessions after a viewer closes', async () => {
    const service = new TerminalSessionService({
      cwd: process.cwd(),
      backend: new MemoryTerminalBackend('ready\r\n'),
    })
    const id = await service.spawn({ cols: 20, rows: 8, name: 'One' })
    await Bun.sleep(20)
    const grid = service.grid(id)
    expect(grid?.viewport.some((row) => row.text.includes('ready'))).toBe(true)
    expect(service.getSnapshot().sessions).toHaveLength(1)
    expect(service.getSnapshot().activeBottomId).toBe(id)

    service.write(id, 'echo hi')
    await Bun.sleep(10)
    expect(service.grid(id)?.viewport.some((row) => row.text.includes('echo hi'))).toBe(true)

    service.resize(id, 40, 12, 'bottom')
    expect(service.getSnapshot().sessions[0]?.cols).toBe(40)
    expect(service.getSnapshot().sessions[0]?.rows).toBe(12)

    service.resize(id, 80, 24, 'right')
    expect(service.getSnapshot().sessions[0]?.cols).toBe(40)
    service.claimSize(id, 'right')
    service.resize(id, 80, 24, 'right')
    expect(service.getSnapshot().sessions[0]?.cols).toBe(80)
    expect(service.getSnapshot().sessions[0]?.rows).toBe(24)

    const second = await service.spawn({ name: 'Two' })
    service.select('right', second)
    expect(service.getSnapshot().activeRightId).toBe(second)
    expect(service.getSnapshot().sessions).toHaveLength(2)

    await service.close(id)
    expect(service.getSnapshot().sessions.map((session) => session.id)).toEqual([second])
    await service.dispose()
  })

  it('holds partial synchronized frames and releases a complete frame atomically', async () => {
    const backend = new PushTerminalBackend()
    const service = new TerminalSessionService({ cwd: process.cwd(), backend })
    const id = await service.spawn({ cols: 30, rows: 3 })
    const committed = service.grid(id)

    backend.emit(ESC + '[?2026hpartial')
    expect(service.grid(id)).toBe(committed)
    expect(service.grid(id)?.viewport.some((row) => row.text.includes('partial'))).toBe(false)

    backend.emit(' frame' + ESC + '[?2026l')
    expect(service.grid(id)?.viewport.some((row) => row.text.includes('partial frame'))).toBe(true)
    await service.dispose()
  })

  it('parses PTY output immediately while coalescing ordinary paints per frame', async () => {
    const backend = new PushTerminalBackend()
    const service = new TerminalSessionService({ cwd: process.cwd(), backend })
    const id = await service.spawn({ cols: 80, rows: 8 })
    let notifications = 0
    const unsubscribe = service.subscribe(() => { notifications += 1 })

    for (let index = 0; index < 64; index += 1) backend.emit(String(index % 10))
    expect(service.grid(id)?.viewport.some((row) => row.text.length > 0)).toBe(true)
    await Bun.sleep(25)
    expect(notifications).toBe(1)

    backend.emit(ESC + '[6n')
    expect(backend.writes.some((write) => typeof write === 'string' && write.startsWith(ESC + '['))).toBe(true)
    unsubscribe()
    await service.dispose()
  })

  it('anchors a detached viewport while new output extends scrollback', async () => {
    const backend = new PushTerminalBackend()
    const service = new TerminalSessionService({ cwd: process.cwd(), backend })
    const id = await service.spawn({ cols: 20, rows: 3 })
    backend.emit('one\r\ntwo\r\nthree\r\nfour')
    service.setScrollOffset(id, 1)
    const before = service.grid(id)?.viewport.map((row) => row.text)

    backend.emit('\r\nfive')
    const after = service.grid(id)?.viewport.map((row) => row.text)

    expect(after).toEqual(before)
    expect(service.grid(id)?.scrollOffset).toBe(2)
    await service.dispose()
  })

  it('reuses an existing session from ensureSession', async () => {
    const service = new TerminalSessionService({ cwd: process.cwd(), backend: new MemoryTerminalBackend() })
    const first = await service.ensureSession('bottom', { cols: 10, rows: 5 })
    const again = await service.ensureSession('bottom')
    expect(again).toBe(first)
    await service.dispose()
  })
})
