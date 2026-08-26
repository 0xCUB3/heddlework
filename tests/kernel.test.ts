import { describe, expect, it } from 'bun:test'
import { serviceToken, slotToken, WorkbenchKernel } from '../src/core/kernel.ts'

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

  it('refuses consumers whose required service is absent', () => {
    const missing = serviceToken<string>('missing')
    const kernel = new WorkbenchKernel()
    expect(() => kernel.mount({ id: 'consumer', requires: [missing], activate() {} })).toThrow('Missing service: missing')
  })
})
