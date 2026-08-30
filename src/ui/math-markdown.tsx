import React, { useEffect, useState } from 'react'
import type { EventPayload } from '@gpuix/react'
import { containsPotentialMath, segmentMathMarkdown, type MathSegment } from './math-segment.ts'
import { formulaFallbackSource, loadFormulaRenderer, type FormulaRenderer } from './math-engine.ts'
import { markdownSourceWithNewlines } from './markdown-source.ts'
import { colors } from './theme.ts'

export interface MathMarkdownProps {
  source: string
  theme: Record<string, unknown> | undefined
  testId: string | undefined
  style: Record<string, unknown> | undefined
  onLinkClick: ((event: EventPayload) => void) | undefined
}

type InlinePart = { kind: 'text'; source: string } | { kind: 'math'; latex: string }
type MathRow = { type: 'inline'; parts: InlinePart[] } | { type: 'display'; latex: string }

export function MathMarkdown(props: MathMarkdownProps) {
  const { source } = props
  if (!containsPotentialMath(source)) return <PlainMarkdown {...props} source={markdownSourceWithNewlines(source)} />
  const segments = segmentMathMarkdown(source)
  if (segments.every((segment) => segment.kind === 'text')) return <PlainMarkdown {...props} />
  return <SegmentedMarkdown {...props} segments={segments} />
}

function PlainMarkdown({ source, theme, testId, style, onLinkClick }: MathMarkdownProps) {
  return React.createElement('markdown', {
    source,
    ...(testId !== undefined ? { testId } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(onLinkClick !== undefined ? { onLinkClick } : {}),
  } as never)
}

function SegmentedMarkdown({ segments, theme, testId, style, onLinkClick }: MathMarkdownProps & { segments: Array<MathSegment> }) {
  const renderer = useFormulaRenderer()
  const rows = buildRows(segments)
  const ink = (theme as { text?: string } | undefined)?.text ?? colors.text
  const fontSizePx = (theme as { metrics?: { mdTextSize?: number } } | undefined)?.metrics?.mdTextSize ?? 14
  return (
    <div
      {...(testId !== undefined ? { testId } : {})}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 4, ...(style ?? {}) }}
    >
      {rows.map((row, index) => {
        if (row.type === 'display') {
          return (
            <div key={index} style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', minWidth: 0 }}>
              <Formula latex={row.latex} display renderer={renderer} ink={ink} fontSizePx={fontSizePx} />
            </div>
          )
        }
        return (
          <div
            key={index}
            style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', width: '100%', minWidth: 0, gap: 3 }}
          >
            {row.parts.map((part, partIndex) => part.kind === 'text'
              ? (
                  <PlainMarkdown
                    key={partIndex}
                    source={markdownSourceWithNewlines(part.source)}
                    theme={theme}
                    testId={undefined}
                    style={{ minWidth: 0 }}
                    onLinkClick={onLinkClick}
                  />
                )
              : <Formula key={partIndex} latex={part.latex} display={false} renderer={renderer} ink={ink} fontSizePx={fontSizePx} />)}
          </div>
        )
      })}
    </div>
  )
}

function Formula({ latex, display, renderer, ink, fontSizePx }: {
  latex: string
  display: boolean
  renderer: FormulaRenderer | null
  ink: string
  fontSizePx: number
}) {
  const rendered = renderer ? renderer(latex, display, undefined, fontSizePx) : null
  if (!rendered) {
    return React.createElement('markdown', {
      source: formulaFallbackSource(latex, display),
      style: { width: '100%', minWidth: 0 },
    } as never)
  }
  return React.createElement('svg', {
    source: rendered.svg,
    style: { width: rendered.widthPx, height: rendered.heightPx, flexShrink: 0, color: ink },
  } as never)
}

function buildRows(segments: Array<MathSegment>): Array<MathRow> {
  const rows: Array<MathRow> = []
  let parts: Array<InlinePart> = []
  const flush = (): void => {
    if (parts.some((part) => part.kind === 'math' || part.source.trim() !== '')) {
      rows.push({ type: 'inline', parts })
    }
    parts = []
  }
  for (const segment of segments) {
    if (segment.kind === 'math') {
      flush()
      rows.push({ type: 'display', latex: segment.latex })
      continue
    }
    const paragraphs = segment.text.split(/\n[ \t]*\n/)
    paragraphs.forEach((paragraph, paragraphIndex) => {
      if (paragraphIndex > 0) flush()
      if (paragraph.trim() !== '') parts.push({ kind: 'text', source: paragraph })
    })
  }
  flush()
  return rows
}

let cachedRenderer: FormulaRenderer | null | undefined

function useFormulaRenderer(): FormulaRenderer | null {
  const [renderer, setRenderer] = useState<FormulaRenderer | null>(() => (cachedRenderer === undefined ? null : cachedRenderer))
  useEffect(() => {
    if (cachedRenderer !== undefined) return
    let alive = true
    void loadFormulaRenderer().then((loaded) => {
      cachedRenderer = loaded
      if (alive) setRenderer(() => loaded)
    })
    return () => {
      alive = false
    }
  }, [])
  return renderer
}
