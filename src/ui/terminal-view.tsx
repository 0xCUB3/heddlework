import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useGpuix } from '@gpuix/react'
import type { TerminalGridSnapshot, TerminalPlacement, TerminalSessionId } from '../terminal/types.ts'
import { encodeTerminalKey, wrapBracketedPaste, type TerminalKeyEvent } from '../terminal/keys.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import { copyTextToClipboard } from './clipboard-media.ts'
import { colors } from './theme.ts'
import { TERMINAL_CELL_WIDTH, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT, TERMINAL_PADDING_X, TERMINAL_PADDING_Y, terminalGridSize } from './terminal-metrics.ts'
import { terminalPaintTheme, terminalRowRuns, type TerminalPaintTheme, type TerminalRunStyle } from './terminal-theme.ts'
import type { ResolvedTheme } from './theme.ts'

const CAPTURE_TAB_PROPS = { captureTab: true } as const

export function TerminalView({
  service,
  sessionId,
  placement,
  width,
  height,
  appearance,
  focusSerial = 1,
}: {
  service: TerminalSessionService
  sessionId: TerminalSessionId | undefined
  placement: TerminalPlacement
  width: number
  height: number
  appearance: ResolvedTheme
  focusSerial?: number
}) {
  const snapshot = sessionId ? service.grid(sessionId) : undefined
  const theme = useMemo(() => terminalPaintTheme(appearance), [appearance])
  const size = terminalGridSize(width, height)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const gpuix = useGpuix()
  const inputId = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!sessionId) return
    service.resize(sessionId, size.cols, size.rows, placement)
  }, [placement, service, sessionId, size.cols, size.rows])

  useEffect(() => {
    if (focusSerial < 1 || !sessionId || inputId.current === undefined) return
    service.claimSize(sessionId, placement)
    service.resize(sessionId, sizeRef.current.cols, sizeRef.current.rows, placement)
    gpuix?.renderer?.focusElement?.(inputId.current)
  }, [focusSerial, gpuix, placement, service, sessionId])

  const focusInput = useCallback(() => {
    if (sessionId) {
      service.claimSize(sessionId, placement)
      service.resize(sessionId, size.cols, size.rows, placement)
    }
    if (inputId.current !== undefined) gpuix?.renderer?.focusElement?.(inputId.current)
  }, [gpuix, placement, service, sessionId, size.cols, size.rows])

  const onKeyDown = useCallback((event: TerminalKeyEvent) => {
    if (!sessionId) return
    const grid = service.grid(sessionId)
    const key = (event.key ?? '').toLowerCase()
    const mods = event.modifiers as { ctrl?: boolean; control?: boolean; alt?: boolean; cmd?: boolean; shift?: boolean } | undefined
    const ctrl = Boolean(mods?.ctrl || mods?.control)
    if (ctrl && !mods?.alt && (key === 'c' || key === 'ctrl-c' || key.endsWith('-c'))) {
      service.write(sessionId, String.fromCharCode(3))
      return
    }
    if (key === 'c' && (mods?.cmd || ctrl) && mods?.shift) {
      void copyTextToClipboard(grid?.viewport.map((row) => row.text).join('\n') ?? '')
      return
    }
    if (key === 'v' && (event.modifiers?.cmd || event.modifiers?.ctrl)) {
      void pasteClipboardText().then((text) => {
        if (!text) return
        service.write(sessionId, wrapBracketedPaste(text, Boolean(grid?.bracketedPaste)))
      })
      return
    }
    const encoded = encodeTerminalKey(event, grid?.applicationCursor)
    if (!encoded) return
    service.write(sessionId, encoded)
  }, [service, sessionId])

  const onScroll = useCallback((event: { deltaY?: number }) => {
    if (!sessionId || !snapshot) return
    const delta = event.deltaY ?? 0
    if (delta === 0) return
    const next = snapshot.scrollOffset + (delta > 0 ? -1 : 1) * Math.max(1, Math.round(Math.abs(delta) / TERMINAL_LINE_HEIGHT))
    service.setScrollOffset(sessionId, next)
  }, [service, sessionId, snapshot])

  return (
    <div
      testId={'terminal-view-' + placement}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        paddingLeft: TERMINAL_PADDING_X,
        paddingRight: TERMINAL_PADDING_X,
        paddingTop: TERMINAL_PADDING_Y,
        paddingBottom: TERMINAL_PADDING_Y,
        backgroundColor: theme.background,
        overflow: 'hidden',
        cursor: 'text',
      }}
      onMouseDown={focusInput}
      onClick={focusInput}
      onScroll={onScroll}
    >
      {snapshot ? <TerminalGrid snapshot={snapshot} theme={theme} /> : <text style={{ color: colors.textFaint, fontSize: 11 }}>No terminal session.</text>}
      <div
        ref={(instance: { id: number } | null) => { inputId.current = instance?.id }}
        testId={'terminal-input-' + placement}
        {...CAPTURE_TAB_PROPS}
        tabIndex={0}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: '100%',
          height: '100%',
          backgroundColor: '#01010101',
          cursor: 'text',
        }}
        onMouseDown={focusInput}
        onClick={focusInput}
        onFocus={focusInput}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
      />
    </div>
  )
}

function TerminalGrid({ snapshot, theme }: { snapshot: TerminalGridSnapshot; theme: TerminalPaintTheme }) {
  return (
    <div testId="terminal-grid" style={{ position: 'relative', width: snapshot.cols * TERMINAL_CELL_WIDTH, height: snapshot.rows * TERMINAL_LINE_HEIGHT, display: 'flex', flexDirection: 'column' }}>
      {snapshot.viewport.map((row, rowIndex) => (
        <div key={rowIndex} style={{ height: TERMINAL_LINE_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row' }}>
          {terminalRowRuns(row.cells, theme).map((run, runIndex) => <TerminalRun key={runIndex} run={run} theme={theme} />)}
        </div>
      ))}
      {snapshot.cursorVisible ? <TerminalCursor x={snapshot.cursorX} y={snapshot.cursorY} color={theme.cursor} /> : null}
    </div>
  )
}

function TerminalRun({ run, theme }: { run: TerminalRunStyle; theme: TerminalPaintTheme }) {
  const width = run.columns * TERMINAL_CELL_WIDTH
  const backgroundColor = run.fill ? run.color : run.backgroundColor === theme.background ? colors.transparent : run.backgroundColor
  return (
    <div style={{ width, height: TERMINAL_LINE_HEIGHT, flexShrink: 0, backgroundColor }}>
      {run.fill ? null : (
        <text style={{ color: run.color, fontSize: TERMINAL_FONT_SIZE, lineHeight: TERMINAL_LINE_HEIGHT, fontFamily: TERMINAL_FONT_FAMILY, whiteSpace: 'nowrap' }}>{run.text}</text>
      )}
    </div>
  )
}

function TerminalCursor({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <div
      testId="terminal-cursor"
      style={{
        position: 'absolute',
        left: x * TERMINAL_CELL_WIDTH,
        top: y * TERMINAL_LINE_HEIGHT,
        width: TERMINAL_CELL_WIDTH,
        height: TERMINAL_LINE_HEIGHT,
        backgroundColor: color,
        opacity: 0.35,
        pointerEvents: 'none',
      }}
    />
  )
}

async function pasteClipboardText(): Promise<string | undefined> {
  try {
    if (process.platform === 'darwin') {
      const proc = Bun.spawn(['/usr/bin/pbpaste'], { stdout: 'pipe' })
      return (await new Response(proc.stdout).text()) || undefined
    }
    if (process.platform === 'win32') {
      const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', 'Get-Clipboard'], { stdout: 'pipe' })
      return (await new Response(proc.stdout).text()) || undefined
    }
    for (const command of [['wl-paste'], ['xclip', '-selection', 'clipboard', '-o']] as const) {
      try {
        const proc = Bun.spawn(command as unknown as string[], { stdout: 'pipe' })
        const text = await new Response(proc.stdout).text()
        if (text) return text
      } catch {
        continue
      }
    }
  } catch {
    return undefined
  }
  return undefined
}
