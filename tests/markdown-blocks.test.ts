// The DOM host renders markdown through src/dom/rich.tsx; these cases cover the shared block parser it consumes.
import { describe, expect, it } from 'bun:test'
import { parseInline, parseMarkdownBlocks } from '../src/web/markdown-blocks.ts'

describe('markdown blocks', () => {
  it('parses the block kinds agent replies use', () => {
    const blocks = parseMarkdownBlocks([
      '## PR body',
      '',
      'Paste was wrapping. `paste.ts` now splits on hard newlines.',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '- one',
      '- two `x`',
      '',
      '1. first',
      '2. second',
      '',
      '> quoted',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '---',
    ].join('\n'))
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'code', 'list', 'list', 'quote', 'table', 'rule'])
    expect(blocks[2]).toEqual({ kind: 'code', language: 'ts', text: 'const a = 1' })
    expect((blocks[4] as { start: number }).start).toBe(1)
    expect((blocks[6] as { rows: unknown[] }).rows).toHaveLength(1)
  })

  it('keeps snake_case identifiers and lone asterisks as text', () => {
    expect(parseInline('billing/retry_key and a * b')).toEqual([{ kind: 'text', text: 'billing/retry_key and a * b' }])
    expect(parseInline('**bold** and _em_ and ~~gone~~')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'em', children: [{ kind: 'text', text: 'em' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'strike', children: [{ kind: 'text', text: 'gone' }] },
    ])
  })
})
