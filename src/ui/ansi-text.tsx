import React, { useMemo } from 'react'
import { colors, nativeTheme } from './theme.ts'
import { plainExtensionText } from './extension-ui.ts'

export interface AnsiRun { text: string; color?: number | string; bold?: boolean }
function rgb(red: number, green: number, blue: number): string | undefined {
  if (![red, green, blue].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return undefined
  return `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`
}
function indexedColor(value: number): number | string | undefined {
  if (!Number.isInteger(value) || value < 0 || value > 255) return undefined
  if (value < 16) return value % 8
  if (value >= 232) { const gray = 8 + (value - 232) * 10; return rgb(gray, gray, gray) }
  const index = value - 16
  const channel = (n: number) => n === 0 ? 0 : 55 + n * 40
  return rgb(channel(Math.floor(index / 36)), channel(Math.floor(index / 6) % 6), channel(index % 6))
}
export function ansiRuns(source: string): AnsiRun[] {
  const runs: AnsiRun[] = []
  const pattern = /\u001b\[([0-9;]*)m/g
  let index = 0
  let color: number | string | undefined
  let bold = false
  const append = (text: string) => { const clean = plainExtensionText(text); if (clean) runs.push({ text: clean, ...(color === undefined ? {} : { color }), ...(bold ? { bold: true } : {}) }) }
  const bounded = source.slice(0, 24000)
  for (const match of bounded.matchAll(pattern)) {
    append(bounded.slice(index, match.index))
    const codes = (match[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!
      if (code === 0) { color = undefined; bold = false }
      else if (code === 1) bold = true
      else if (code === 22) bold = false
      else if (code === 39) color = undefined
      else if (code >= 30 && code <= 37) color = code - 30
      else if (code >= 90 && code <= 97) color = code - 90
      else if (code === 38 || code === 48) {
        const mode = codes[i + 1]
        if (mode === 2) { if (code === 38) color = rgb(codes[i + 2]!, codes[i + 3]!, codes[i + 4]!); i += 4 }
        else if (mode === 5) { if (code === 38) color = indexedColor(codes[i + 2]!); i += 2 }
      }
    }
    index = match.index + match[0].length
    if (runs.length >= 256) break
  }
  append(bounded.slice(index))
  return runs
}
export function readableAnsiColor(color: string, background: string): string {
  const parse = (value: string) => /^#[0-9a-f]{6}$/i.test(value) ? [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) : undefined
  const foreground = parse(color)
  const backdrop = parse(background)
  if (!foreground || !backdrop) return color
  const luminance = (channels: number[]) => channels.map(c => { const n = c / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4 }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0)
  const bg = luminance(backdrop)
  const target = bg > 0.179 ? 0 : 255
  for (let step = 0; step <= 20; step++) {
    const channels = foreground.map(c => Math.round(c + (target - c) * step / 20))
    const fg = luminance(channels)
    if ((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) >= 4.5) return rgb(channels[0]!, channels[1]!, channels[2]!)!
  }
  return target ? '#ffffff' : '#000000'
}
export function AnsiText({ text, testId, size = 10 }: { text: string; testId?: string; size?: number }) {
  const lines = useMemo(() => {
    const result: AnsiRun[][] = [[]]
    for (const run of ansiRuns(text)) run.text.split('\n').forEach((part, index) => { if (index) result.push([]); if (part) result.at(-1)!.push({ ...run, text: part }) })
    return result
  }, [text])
  const palette = [colors.textMuted, colors.error, colors.success, colors.warning, colors.info, colors.primary, colors.info, colors.text]
  return <div {...(testId ? { testId } : {})} style={{ minWidth: 0, maxWidth: '100%', display: 'flex', flexDirection: 'column' }}>
    {lines.map((runs, line) => <div key={line} style={{ minWidth: 0, maxWidth: '100%', minHeight: size * 1.5, display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline' }}>
      {runs.map((run, i) => <text key={i} style={{ minWidth: 0, color: typeof run.color === 'string' ? readableAnsiColor(run.color, colors.background) : run.color === undefined ? colors.textMuted : (palette[run.color] ?? colors.textMuted), fontWeight: run.bold ? 650 : 400, fontSize: size, lineHeight: size * 1.5, fontFamily: nativeTheme.fontMono, whiteSpace: 'normal' }}>{run.text}</text>)}
    </div>)}
  </div>
}
