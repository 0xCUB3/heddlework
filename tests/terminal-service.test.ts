import { describe, expect, it } from 'bun:test'
import { MemoryTerminalBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'

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

  it('reuses an existing session from ensureSession', async () => {
    const service = new TerminalSessionService({ cwd: process.cwd(), backend: new MemoryTerminalBackend() })
    const first = await service.ensureSession('bottom', { cols: 10, rows: 5 })
    const again = await service.ensureSession('bottom')
    expect(again).toBe(first)
    await service.dispose()
  })
})
