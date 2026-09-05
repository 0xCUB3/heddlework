// Upstream Heddlework compiles against a GPUix branch that adds a native terminal surface, a CEF browser
// element, motion on layout properties, and window-lifecycle callbacks. Those additions are not in the
// published @gpuix packages yet. These augmentations describe that API so the code typechecks against
// the npm release; every call site feature-detects at runtime and falls back when the primitive is missing.

import type { JSX as GpuixJSX } from '@gpuix/react/jsx-runtime'

// The same prop surface a native <div> accepts, plus key for list rendering.
type NativeBoxProps = GpuixJSX.IntrinsicElements['div']

export interface NativeTerminalElementProps extends NativeBoxProps {
  frame?: unknown
}

export interface NativeBrowserElementProps extends NativeBoxProps {
  source?: string
  generation?: number
  profileId?: string
  profilePath?: string
  incognito?: boolean
  visible?: boolean
  command?: string
  onBrowserState?: (event: { value?: string | undefined }) => void
  onBrowserOpen?: (event: { value?: string | undefined }) => void
  onBrowserError?: (event: { value?: string | undefined }) => void
  onBrowserAck?: (event: { value?: string | undefined }) => void
}

declare module '@gpuix/react' {
  interface MotionStyle {
    flexGrow?: number
    flexShrink?: number
    flexBasis?: number
    paddingLeft?: number
    paddingRight?: number
    paddingTop?: number
    paddingBottom?: number
    marginLeft?: number
    marginRight?: number
    marginTop?: number
    marginBottom?: number
    gap?: number
    minWidth?: number
    minHeight?: number
    maxWidth?: number
    maxHeight?: number
  }

  interface RenderOptions {
    // Called once the native window has been torn down by the OS or the runtime.
    onTerminated?: () => void
  }
}

declare module '@gpuix/native' {
  interface WindowOptions {
    // Root directory for Chromium profile caches; ignored by builds without CEF.
    browserRootCachePath?: string
    nativeBrowserEnabled?: boolean
  }

  interface GpuixRenderer {
    supportsNativeTerminal?(): boolean
    setTerminalFrame?(elementId: number, metadata: string, cells: Uint8Array): void
    supportsNativeBrowser?(): boolean
    nativeBrowserEngine?(): string
    nativeBrowserProfileIsolation?(): string
    nativeBrowserError?(): string | null
  }
}

declare module '@gpuix/react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      terminal: NativeTerminalElementProps
      browser: NativeBrowserElementProps
    }
  }
}
