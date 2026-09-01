import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useGpuix } from '@gpuix/react'
import type { TerminalAppearance, TerminalGridSnapshot, TerminalPlacement, TerminalRow as TerminalGridRow, TerminalSessionId } from '../terminal/types.ts'
import { encodeTerminalKey, wrapBracketedPaste, type TerminalKeyEvent } from '../terminal/keys.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import { copyTextToClipboard } from './clipboard-media.ts'
import { colors } from './theme.ts'
import { TERMINAL_CELL_WIDTH, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT, TERMINAL_PADDING_X, TERMINAL_PADDING_Y, terminalGridSize } from './terminal-metrics.ts'
import { terminalNativeBinaryFrame, terminalNativeFrame } from './terminal-native.ts'
import { terminalPaintTheme, terminalRowRuns, type TerminalPaintTheme, type TerminalRunStyle } from './terminal-theme.ts'
import type { ResolvedTheme } from './theme.ts'

const CAPTURE_TAB_PROPS = { captureTab: true } as const
type TerminalCapableRenderer = {
  supportsNativeTerminal?: () => boolean
  setTerminalFrame?: (elementId: number, metadata: string, cells: Uint8Array) => void
}

export const TerminalView = memo(function TerminalView({
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
  const serviceSnapshot = useSyncExternalStore(service.subscribe, service.getSnapshot)
  const rendering = serviceSnapshot.appearance
  const snapshot = sessionId ? service.grid(sessionId) : undefined
  const theme = useMemo(() => terminalPaintTheme(appearance), [appearance])
  const size = terminalGridSize(width, height)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const gpuix = useGpuix()
  const nativeTerminal = (gpuix?.renderer as TerminalCapableRenderer | undefined)?.supportsNativeTerminal?.() === true
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
      {snapshot ? (nativeTerminal
        ? <NativeTerminalGrid snapshot={snapshot} theme={theme} rendering={rendering} />
        : <TerminalGrid snapshot={snapshot} theme={theme} rendering={rendering} />
      ) : <text style={{ color: colors.textFaint, fontSize: 11 }}>No terminal session.</text>}
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
})

const NativeTerminalGrid = memo(function NativeTerminalGrid({ snapshot, theme, rendering }: { snapshot: TerminalGridSnapshot; theme: TerminalPaintTheme; rendering: TerminalAppearance }) {
  const gpuix = useGpuix()
  const renderer = gpuix?.renderer as TerminalCapableRenderer | undefined
  const direct = typeof renderer?.setTerminalFrame === 'function'
  const binaryFrame = useMemo(
    () => direct ? terminalNativeBinaryFrame(snapshot, theme, rendering) : undefined,
    [direct, rendering, snapshot, theme],
  )
  const fallbackFrame = useMemo(
    () => direct ? undefined : terminalNativeFrame(snapshot, theme, rendering),
    [direct, rendering, snapshot, theme],
  )
  const terminalId = useRef<number | undefined>(undefined)

  useLayoutEffect(() => {
    if (!binaryFrame || terminalId.current === undefined || !renderer?.setTerminalFrame) return
    const { cells, ...metadata } = binaryFrame
    const payload = typeof Buffer === 'undefined'
      ? cells
      : Buffer.from(cells.buffer, cells.byteOffset, cells.byteLength)
    renderer.setTerminalFrame(terminalId.current, JSON.stringify(metadata), payload)
  }, [binaryFrame, renderer])

  return React.createElement('terminal', {
    ref: (instance: { id: number } | null) => { terminalId.current = instance?.id },
    testId: 'terminal-grid',
    ...(fallbackFrame ? { frame: fallbackFrame } : {}),
    style: {
      position: 'relative',
      width: snapshot.cols * TERMINAL_CELL_WIDTH,
      height: snapshot.rows * TERMINAL_LINE_HEIGHT,
      overflow: 'hidden',
    },
  })
})

function TerminalGrid({ snapshot, theme, rendering }: { snapshot: TerminalGridSnapshot; theme: TerminalPaintTheme; rendering: TerminalAppearance }) {
  return (
    <div testId="terminal-grid" style={{ position: 'relative', width: snapshot.cols * TERMINAL_CELL_WIDTH, height: snapshot.rows * TERMINAL_LINE_HEIGHT, display: 'flex', flexDirection: 'column' }}>
      {snapshot.viewport.map((row, rowIndex) => (
        <TerminalRow key={rowIndex} row={row} theme={theme} rendering={rendering} />
      ))}
      {snapshot.cursorVisible ? <TerminalCursor x={snapshot.cursorX} y={snapshot.cursorY} color={theme.cursor} /> : null}
    </div>
  )
}

const TerminalRow = memo(function TerminalRow({ row, theme, rendering }: { row: TerminalGridRow; theme: TerminalPaintTheme; rendering: TerminalAppearance }) {
  const runs = useMemo(() => terminalRowRuns(row.cells, theme, rendering), [rendering, row, theme])
  return (
    <div style={{ height: TERMINAL_LINE_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row' }}>
      {runs.map((run, runIndex) => <TerminalRun key={runIndex} run={run} theme={theme} />)}
    </div>
  )
})

function TerminalRun({ run, theme }: { run: TerminalRunStyle; theme: TerminalPaintTheme }) {
  const width = run.columns * TERMINAL_CELL_WIDTH
  const backgroundColor = run.fill ? run.color : run.backgroundColor === theme.background ? colors.transparent : run.backgroundColor
  const fontFamily = run.fontStyle === 'italic' ? `${run.fontFamily} Italic` : run.fontFamily
  return (
    <div style={{ position: 'relative', width, height: TERMINAL_LINE_HEIGHT, flexShrink: 0, backgroundColor }}>
      {run.fill ? null : (
        <text style={{ color: run.color, fontSize: TERMINAL_FONT_SIZE, lineHeight: TERMINAL_LINE_HEIGHT, fontFamily, ...(run.fontWeight ? { fontWeight: run.fontWeight } : {}), whiteSpace: 'nowrap' }}>{run.text}</text>
      )}
      {!run.fill && run.underline ? <div style={{ position: 'absolute', left: 0, right: 0, bottom: 1, height: 1, backgroundColor: run.color, pointerEvents: 'none' }} /> : null}
      {!run.fill && run.strike ? <div style={{ position: 'absolute', left: 0, right: 0, top: Math.floor(TERMINAL_LINE_HEIGHT * 0.52), height: 1, backgroundColor: run.color, pointerEvents: 'none' }} /> : null}
    </div>
  )
}

const TerminalCursor = memo(function TerminalCursor({ x, y, color }: { x: number; y: number; color: string }) {
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
})

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
