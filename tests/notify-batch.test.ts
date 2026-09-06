import { describe, expect, it } from 'bun:test'
import { liveFieldsOnlyChanged, TrailingNotifier } from '../src/workbench/notify-batch.ts'

describe('live notify batching', () => {
  it('treats live assistant, tools, and activity as high-frequency fields', () => {
    const base = { messages: [], liveAssistant: { id: 'live' }, liveTools: [], activity: 'Working', session: { isStreaming: true } }
    expect(liveFieldsOnlyChanged(base, { ...base, liveAssistant: { id: 'live', text: 'Hi' } })).toBe(true)
    expect(liveFieldsOnlyChanged(base, { ...base, activity: 'Thinking' })).toBe(true)
    expect(liveFieldsOnlyChanged(base, { ...base, session: { isStreaming: false } })).toBe(false)
    expect(liveFieldsOnlyChanged(base, { ...base, messages: [{ role: 'assistant' }] })).toBe(false)
    expect(liveFieldsOnlyChanged(base, base)).toBe(false)
  })

  it('coalesces trailing notifies and flushes immediately when asked', async () => {
    let count = 0
    const notifier = new TrailingNotifier(() => {
      count += 1
    }, 20)
    notifier.notify(false)
    notifier.notify(false)
    notifier.notify(false)
    expect(count).toBe(0)
    await Bun.sleep(40)
    expect(count).toBe(1)
    notifier.notify(true)
    expect(count).toBe(2)
    notifier.notify(false)
    notifier.cancel()
    await Bun.sleep(40)
    expect(count).toBe(2)
  })
})
