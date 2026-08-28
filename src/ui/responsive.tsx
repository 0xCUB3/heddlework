import React, { createContext, useContext } from 'react'

export type ViewportClass = 'mobile' | 'tablet' | 'desktop'

export interface ResponsiveLayout {
  viewportClass: ViewportClass
  viewportWidth: number
  mobile: boolean
  compact: boolean
  navigationOverlay: boolean
  panelOverlay: boolean
  contentGutter: number
  composerGutter: number
  sidebarWidth: number
  popoverWidth: number
}

export const MOBILE_BREAKPOINT = 600
export const TABLET_BREAKPOINT = 1_024
export const DESKTOP_SIDEBAR_WIDTH = 256

export function resolveResponsiveLayout(width: number): ResponsiveLayout {
  const viewportWidth = Number.isFinite(width) && width > 0 ? width : 1_200
  const mobile = viewportWidth < MOBILE_BREAKPOINT
  const tablet = !mobile && viewportWidth <= TABLET_BREAKPOINT
  const compact = mobile || tablet
  const composerGutter = mobile ? 10 : tablet ? 16 : 20

  return {
    viewportClass: mobile ? 'mobile' : tablet ? 'tablet' : 'desktop',
    viewportWidth,
    mobile,
    compact,
    navigationOverlay: compact,
    panelOverlay: compact,
    contentGutter: mobile ? 12 : tablet ? 16 : 20,
    composerGutter,
    sidebarWidth: Math.min(DESKTOP_SIDEBAR_WIDTH, viewportWidth),
    popoverWidth: Math.max(180, Math.min(320, viewportWidth - composerGutter * 2)),
  }
}

const ResponsiveLayoutContext = createContext<ResponsiveLayout>(resolveResponsiveLayout(1_200))

export function ResponsiveLayoutProvider({ layout, children }: { layout: ResponsiveLayout; children: React.ReactNode }) {
  return <ResponsiveLayoutContext.Provider value={layout}>{children}</ResponsiveLayoutContext.Provider>
}

export function useResponsiveLayout(): ResponsiveLayout {
  return useContext(ResponsiveLayoutContext)
}
