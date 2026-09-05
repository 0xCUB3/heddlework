import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { it } from 'bun:test'

// Upstream targets a GPUix branch with a native <terminal> element and animated layout properties.
// The published package lacks both, so tests that assert on those primitives skip until it ships.

let probed: { nativeTerminal: boolean; layoutMotion: boolean } | undefined

function probe(): { nativeTerminal: boolean; layoutMotion: boolean } {
  if (probed) return probed
  if (!hasNativeTestRenderer) {
    probed = { nativeTerminal: false, layoutMotion: false }
    return probed
  }
  const root = createTestRoot({ width: 64, height: 64 })
  try {
    const renderer = root.renderer as { supportsNativeTerminal?: () => boolean; setTerminalFrame?: unknown; supportsLayoutMotion?: () => boolean }
    const nativeTerminal = renderer.supportsNativeTerminal?.() === true && typeof renderer.setTerminalFrame === 'function'
    // Layout motion arrived in the same GPUix branch as the terminal surface; a dedicated probe wins when present.
    const layoutMotion = typeof renderer.supportsLayoutMotion === 'function' ? renderer.supportsLayoutMotion() : nativeTerminal
    probed = { nativeTerminal, layoutMotion }
  } finally {
    root.unmount()
  }
  return probed
}

export function hasNativeTerminal(): boolean {
  return probe().nativeTerminal
}

export function hasLayoutMotion(): boolean {
  return probe().layoutMotion
}

// The patch ships as one unit, so the terminal probe stands in for its other fixes too: Tab reaching
// onKeyDown, clicks delivered on primary mouse-up, and animated layout properties.
export function hasPatchedGpuix(): boolean {
  return probe().nativeTerminal
}

export function itWithPatchedGpuix(name: string, fn: () => Promise<void> | void, timeout?: number): void {
  ;(hasPatchedGpuix() ? it : it.skip)(name, fn, timeout)
}
