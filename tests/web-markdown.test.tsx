import { describe, expect, it } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseInline, parseMarkdownBlocks } from '../src/web/markdown-blocks.ts'
import { MarkdownBody } from '../src/web/markdown.tsx'

const html = (source: string): string => renderToStaticMarkup(<MarkdownBody source={source} />)

describe('web markdown blocks', () => {
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

  it('renders inline code, links, and bare urls as html', () => {
    const out = html('See `wrangler deploy` at https://example.com/x?y=1 and [docs](https://d.example).')
    expect(out).toContain('<code>wrangler deploy</code>')
    expect(out).toContain('href="https://example.com/x?y=1"')
    expect(out).toContain('href="https://d.example"')
    expect(out).not.toContain('`')
  })

  it('renders fenced code and tables without leaking markers', () => {
    const out = html('```sh\nls -la\n```\n\n| k | v |\n|---|---|\n| a | b |')
    expect(out).toContain('<pre class="web-md-code" data-language="sh"><code>ls -la</code></pre>')
    expect(out).toContain('<th>k</th>')
    expect(out).toContain('<td>b</td>')
    expect(out).not.toContain('|')
  })

  it('keeps display math on its own row next to real paragraphs', () => {
    const out = html('Before\n\n$$x^2$$\n\nAfter')
    expect(out).toContain('web-math-display')
    expect(out).toContain('<p>Before</p>')
    expect(out).toContain('<p>After</p>')
  })
})
