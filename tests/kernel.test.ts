import { describe, expect, it } from 'bun:test'
import { serviceToken, slotToken, WorkbenchKernel } from '../src/core/kernel.ts'

declare module '../src/core/kernel.ts' {
  interface WorkbenchEvents {
    'test/observe'(value: string): void
    'test/parallel'(value: string): void | Promise<void>
    'test/serial'(value: string): string | false | undefined | Promise<string | false | undefined>
    'test/bail'(value: string): string | false | undefined
    'test/waterfall'(value: string, next: () => string): string
  }
}

describe('WorkbenchKernel', () => {
  it('activates dependencies and reverses owned effects', async () => {
    const service = serviceToken<{ value: number }>('answer')
    const order: string[] = []
    const kernel = new WorkbenchKernel()
    kernel.mount({
      id: 'provider',
      activate(ctx) {
        ctx.provide(service, { value: 42 })
        ctx.effect(() => () => { order.push('provider-effect') })
      },
    })
    kernel.mount({
      id: 'consumer',
      requires: [service],
      activate(ctx) {
        expect(ctx.get(service).value).toBe(42)
        ctx.effect(() => () => { order.push('consumer-effect') })
      },
    })

    await kernel.dispose()
    expect(order).toEqual(['consumer-effect', 'provider-effect'])
    expect(() => kernel.get(service)).toThrow('Missing service')
  })

  it('waits for injected services and reactivates dependents around provider lifetimes', async () => {
    const service = serviceToken<{ value: number }>('late-answer')
    const order: string[] = []
    let activations = 0
    const kernel = new WorkbenchKernel()
    const removeConsumer = kernel.mount({
      id: 'consumer',
      requires: [service],
      activate(ctx) {
        activations += 1
        order.push(`consumer:${ctx.get(service).value}`)
        return () => { order.push('consumer:stop') }
      },
    })

    expect(activations).toBe(0)
    const removeProvider = kernel.mount({
      id: 'provider',
      activate(ctx) {
        ctx.provide(service, { value: 42 })
        return () => { order.push('provider:stop') }
      },
    })
    expect(activations).toBe(1)
    expect(kernel.get(service).value).toBe(42)

    await removeProvider()
    expect(order.slice(-2)).toEqual(['consumer:stop', 'provider:stop'])
    expect(() => kernel.get(service)).toThrow('Missing service')

    kernel.mount({ id: 'replacement', activate: (ctx) => ctx.provide(service, { value: 7 }) })
    expect(activations).toBe(2)
    expect(order).toContain('consumer:7')

    await removeConsumer()
    await kernel.dispose()
  })

  it('owns typed listeners and composes waterfall middleware', async () => {
    const observed: string[] = []
    const kernel = new WorkbenchKernel()
    const remove = kernel.mount({
      id: 'events',
      activate(ctx) {
        ctx.on('test/observe', (value) => { observed.push(value) })
        ctx.on('test/waterfall', (value, next) => `${value}(${next()})`)
      },
    })

    kernel.emit('test/observe', 'mounted')
    expect(observed).toEqual(['mounted'])
    expect(kernel.waterfall('test/waterfall', 'outer', () => 'inner')).toBe('outer(inner)')

    await remove()
    kernel.emit('test/observe', 'disposed')
    expect(observed).toEqual(['mounted'])
    await kernel.dispose()
  })

  it('supports parallel and ordered decision dispatch', async () => {
    const calls: string[] = []
    const kernel = new WorkbenchKernel()
    kernel.mount({
      id: 'dispatch-modes',
      activate(ctx) {
        ctx.on('test/parallel', async (value) => { await Bun.sleep(1); calls.push(`parallel-a:${value}`) })
        ctx.on('test/parallel', (value) => { calls.push(`parallel-b:${value}`) })
        ctx.on('test/serial', () => false)
        ctx.on('test/serial', async (value) => { calls.push(`serial:${value}`); return 'claimed' })
        ctx.on('test/serial', () => { calls.push('serial:late'); return 'late' })
        ctx.on('test/bail', () => undefined)
        ctx.on('test/bail', (value) => `bail:${value}`)
        ctx.on('test/bail', () => 'late')
      },
    })

    await kernel.parallel('test/parallel', 'event')
    expect(new Set(calls.filter((value) => value.startsWith('parallel')))).toEqual(new Set(['parallel-a:event', 'parallel-b:event']))
    expect(await kernel.serial('test/serial', 'event')).toBe('claimed')
    expect(calls).not.toContain('serial:late')
    expect(kernel.bail('test/bail', 'event')).toBe('bail:event')
    await kernel.dispose()
  })

  it('shadows keyed contributions and restores the previous owner', async () => {
    const slot = slotToken<string>('surface')
    const kernel = new WorkbenchKernel()
    kernel.mount({ id: 'base', activate: (ctx) => ctx.contribute(slot, 'main', 'base') })
    const remove = kernel.mount({ id: 'override', activate: (ctx) => ctx.contribute(slot, 'main', 'override') })

    expect(kernel.contributions(slot).get('main')).toBe('override')
    await remove()
    expect(kernel.contributions(slot).get('main')).toBe('base')
    await kernel.dispose()
  })
})
