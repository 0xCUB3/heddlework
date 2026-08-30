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
export type MathRow =
  | { type: 'markdown'; source: string }
  | { type: 'inline'; parts: InlinePart[] }
  | { type: 'display'; latex: string }

export function MathMarkdown(props: MathMarkdownProps) {
  const { source } = props
  if (!containsPotentialMath(source)) return <PlainMarkdown {...props} source={markdownSourceWithNewlines(source)} />
  const segments = segmentMathMarkdown(source)
  if (segments.every((segment) => segment.kind === 'text')) {
    return <PlainMarkdown {...props} source={markdownSourceWithNewlines(source)} />
  }
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
  const rows = buildMathRows(segments)
  const ink = (theme as { text?: string } | undefined)?.text ?? colors.text
  const fontFamily = (theme as { fontSans?: string } | undefined)?.fontSans
  const fontSizePx = (theme as { metrics?: { mdTextSize?: number } } | undefined)?.metrics?.mdTextSize ?? 14
  const lineHeight = (theme as { metrics?: { mdLineHeight?: number } } | undefined)?.metrics?.mdLineHeight ?? Math.round(fontSizePx * 1.55)
  return (
    <div
      {...(testId !== undefined ? { testId } : {})}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, ...(style ?? {}) }}
    >
      {rows.map((row, index) => {
        if (row.type === 'display') {
          return (
            <div
              key={index}
              style={{
                display: 'flex',
                flexDirection: 'row',
                justifyContent: 'center',
                width: '100%',
                minWidth: 0,
                paddingTop: lineHeight,
                paddingBottom: lineHeight,
              }}
            >
              <Formula latex={row.latex} display renderer={renderer} ink={ink} fontSizePx={fontSizePx} lineHeight={lineHeight} />
            </div>
          )
        }
        if (row.type === 'markdown') {
          return (
            <PlainMarkdown
              key={index}
              source={markdownSourceWithNewlines(row.source)}
              theme={theme}
              testId={undefined}
              style={{ width: '100%', minWidth: 0 }}
              onLinkClick={onLinkClick}
            />
          )
        }
        return (
          <div
            key={index}
            style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', width: '100%', minWidth: 0 }}
          >
            {row.parts.flatMap((part, partIndex) => {
              if (part.kind === 'math') {
                return [
                  <Formula
                    key={`${partIndex}-math`}
                    latex={part.latex}
                    display={false}
                    renderer={renderer}
                    ink={ink}
                    fontSizePx={fontSizePx}
                    lineHeight={lineHeight}
                  />,
                ]
              }
              return tokenizeInlineText(part.source).map((token, tokenIndex) => {
                if (token.kind === 'break') {
                  return <div key={`${partIndex}-br-${tokenIndex}`} style={{ width: '100%', height: 0 }} />
                }
                return (
                  <text
                    key={`${partIndex}-w-${tokenIndex}`}
                    style={{
                      color: ink,
                      fontSize: fontSizePx,
                      lineHeight,
                      flexShrink: 0,
                      ...(fontFamily !== undefined ? { fontFamily } : {}),
                    }}
                  >
                    {token.value}
                  </text>
                )
              })
            })}
          </div>
        )
      })}
    </div>
  )
}

function Formula({ latex, display, renderer, ink, fontSizePx, lineHeight }: {
  latex: string
  display: boolean
  renderer: FormulaRenderer | null
  ink: string
  fontSizePx: number
  lineHeight: number
}) {
  const rendered = renderer ? renderer(latex, display, undefined, fontSizePx) : null
  if (!rendered) {
    if (display) {
      return React.createElement('markdown', {
        source: formulaFallbackSource(latex, true),
        style: { width: '100%', minWidth: 0 },
      } as never)
    }
    return <text style={{ color: ink, fontSize: fontSizePx, lineHeight, fontFamily: 'Menlo', flexShrink: 0 }}>{latex}</text>
  }
  return (
    <div
      testId={display ? 'math-display' : 'math-inline'}
      style={{ width: rendered.widthPx, height: rendered.heightPx, flexShrink: 0 }}
    >
      {React.createElement('svg', {
        source: rendered.svg,
        style: { width: rendered.widthPx, height: rendered.heightPx, flexShrink: 0, color: ink },
      } as never)}
    </div>
  )
}

export function buildMathRows(segments: Array<MathSegment>): Array<MathRow> {
  const rows: Array<MathRow> = []
  let parts: Array<InlinePart> = []
  const flush = (): void => {
    if (parts.length === 0) return
    const hasMath = parts.some((part) => part.kind === 'math')
    if (hasMath) {
      rows.push({ type: 'inline', parts })
    } else {
      const source = parts
        .map((part) => (part.kind === 'text' ? part.source : ''))
        .join('')
        .replace(/^\n+|\n+$/g, '')
      if (source) rows.push({ type: 'markdown', source })
    }
    parts = []
  }
  for (const segment of segments) {
    if (segment.kind === 'math' && segment.display) {
      flush()
      rows.push({ type: 'display', latex: segment.latex })
      continue
    }
    if (segment.kind === 'math') {
      parts.push({ kind: 'math', latex: segment.latex })
      continue
    }
    parts.push({ kind: 'text', source: segment.text })
  }
  flush()
  return rows
}

function tokenizeInlineText(text: string): Array<{ kind: 'word'; value: string } | { kind: 'break' }> {
  const tokens: Array<{ kind: 'word'; value: string } | { kind: 'break' }> = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) tokens.push({ kind: 'break' })
    const words = lines[index]!.match(/\S+\s*|\s+/gu)
    if (!words) continue
    for (const word of words) tokens.push({ kind: 'word', value: word })
  }
  return tokens
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
