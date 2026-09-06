import { createElement } from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Transcript } from '../src/web/transcript.tsx'
import { WEB_TRANSCRIPT_WINDOW_SIZE } from '../src/ui/virtual-window.ts'
import { createInitialState } from '../src/workbench/state.ts'
import type { PiMessage } from '../src/pi/types.ts'

function longSnapshot(turns: number) {
  const messages: PiMessage[] = Array.from({ length: turns }, (_, index) => [
    { role: 'user' as const, content: `Prompt ${index}`, timestamp: index * 2 },
    { role: 'assistant' as const, content: `Answer ${index}`, timestamp: index * 2 + 1 },
  ]).flat()
  return {
    ...createInitialState('/tmp/web-window'),
    session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/web-window.jsonl', sessionId: 'web-window' },
    messages,
  }
}

describe('web transcript window', () => {
  it('keeps a 400-turn chat inside a bounded DOM window at the tail', () => {
    const html = renderToStaticMarkup(createElement(Transcript, { state: longSnapshot(400) }))
    expect(html).toContain('Answer 399')
    expect(html).toContain('data-testid="transcript-window-before"')
    expect(html).not.toContain('Prompt 0')
    const rowCount = html.split('web-transcript-row').length - 1
    expect(rowCount).toBeLessThanOrEqual(WEB_TRANSCRIPT_WINDOW_SIZE)
    expect(rowCount).toBeGreaterThan(20)
  })

  it('renders a short chat without spacers', () => {
    const html = renderToStaticMarkup(createElement(Transcript, { state: longSnapshot(4) }))
    expect(html).toContain('Prompt 0')
    expect(html).toContain('Answer 3')
    expect(html).not.toContain('data-testid="transcript-window-before"')
  })
})
