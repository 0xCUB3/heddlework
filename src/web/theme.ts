import uiContract from '../workbench/ui-contract.json'

type ContractColors = typeof uiContract.colors.dark
export type ColorPalette = ContractColors
export type WebThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'heddlework.webTheme'

export function paletteToCssProperties(palette: ColorPalette): Record<string, string> {
  return {
    '--window': palette.window,
    '--background': palette.background,
    '--sidebar': palette.sidebar,
    '--sidebar-control': palette.sidebarControl,
    '--sidebar-hover': palette.sidebarHover,
    '--sidebar-active': palette.sidebarActive,
    '--settled-text': palette.settledText,
    '--settled-meta': palette.settledMeta,
    '--settled-icon': palette.settledIcon,
    '--settled-divider': palette.settledDivider,
    '--panel': palette.panel,
    '--card': palette.card,
    '--raised': palette.raised,
    '--popover': palette.popover,
    '--hover': palette.hover,
    '--input': palette.input,
    '--border': palette.border,
    '--border-strong': palette.borderStrong,
    '--text': palette.text,
    '--text-muted': palette.textMuted,
    '--text-faint': palette.textFaint,
    '--placeholder': palette.placeholder,
    '--primary': palette.primary,
    '--primary-hover': palette.primaryHover,
    '--info': palette.info,
    '--success': palette.success,
    '--warning': palette.warning,
    '--error': palette.error,
    '--message': palette.message,
    '--composer': palette.composer,
    '--composer-frame': palette.composerFrame,
    '--composer-highlight': palette.composerHighlight,
    '--composer-control-text': palette.composerControlText,
    '--composer-control-icon': palette.composerControlIcon,
    '--context-bar': palette.contextBar,
    '--context-text': palette.contextText,
    '--context-icon': palette.contextIcon,
    '--composer-outline': palette.composerOutline,
    '--code': palette.code,
    '--diff-add': palette.diffAdd,
    '--diff-del': palette.diffDel,
    '--diff-hunk': palette.diffHunkBg,
    '--transparent': palette.transparent,
    '--font-sans': `"${uiContract.typography.fontSans}", Helvetica, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`,
    '--font-mono': `"${uiContract.typography.fontMono}", ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
    '--md-text-size': `${uiContract.typography.textSize}px`,
    '--md-line-height': `${uiContract.typography.lineHeight}px`,
    '--code-text-size': `${uiContract.typography.codeTextSize}px`,
    '--code-line-height': `${uiContract.typography.codeLineHeight}px`,
    '--header-height': `${uiContract.layout.headerHeight}px`,
    '--content-max-width': `${uiContract.layout.contentMaxWidth}px`,
    '--settings-max-width': `${uiContract.layout.settingsMaxWidth}px`,
    '--touch-target': `${uiContract.layout.touchTarget}px`,
  }
}

export function resolveWebTheme(mode: WebThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function readStoredWebTheme(storage: Pick<Storage, 'getItem'> = localStorage): WebThemeMode {
  const value = storage.getItem(STORAGE_KEY)
  if (value === 'light' || value === 'dark' || value === 'system') return value
  return 'system'
}

export function storeWebTheme(mode: WebThemeMode, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(STORAGE_KEY, mode)
}

export function applyWebTheme(resolved: 'light' | 'dark'): void {
  const palette = resolved === 'light' ? uiContract.colors.light : uiContract.colors.dark
  const root = document.documentElement
  for (const [name, value] of Object.entries(paletteToCssProperties(palette))) {
    root.style.setProperty(name, value)
  }
  root.dataset.theme = resolved
}
