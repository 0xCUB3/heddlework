import React from 'react'
import { colors } from './theme.ts'

export function ResizeHandle({ testId, edge, onStart, onStep }: { testId: string; edge: 'left' | 'right'; onStart(position: number): void; onStep(delta: number): void }) {
  return <div testId={testId} tabIndex={0} style={{ position: 'absolute', top: 0, bottom: 0, [edge]: 0, width: 6, userSelect: 'none', cursor: 'ew-resize', backgroundColor: colors.transparent, hover: { backgroundColor: colors.borderStrong } }}
    onMouseDown={event => { if (event.button === undefined || event.button === 0) onStart(event.x ?? 0) }}
    onKeyDown={event => { if (event.key === 'left') onStep(-16); if (event.key === 'right') onStep(16) }} />
}
