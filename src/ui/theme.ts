import { useSyncExternalStore } from 'react'
import uiContract from '../workbench/ui-contract.json'

export type ResolvedTheme = 'light' | 'dark'

export interface ColorPalette {
  window: string
  background: string
  sidebar: string
  sidebarControl: string
  sidebarHover: string
  sidebarActive: string
  settledText: string
  settledMeta: string
  settledIcon: string
  settledDivider: string
  panel: string
  card: string
  raised: string
  popover: string
  hover: string
  input: string
  border: string
  borderStrong: string
  text: string
  textMuted: string
  textFaint: string
  placeholder: string
  primary: string
  primaryHover: string
  info: string
  success: string
  warning: string
  error: string
  message: string
  composer: string
  composerFrame: string
  composerHighlight: string
  composerControlText: string
  composerControlIcon: string
  contextBar: string
  contextText: string
  contextIcon: string
  composerOutline: string
  code: string
  diffAdd: string
  diffDel: string
  diffHunkBg: string
  transparent: string
}

export const darkColors: ColorPalette = uiContract.colors.dark
export const lightColors: ColorPalette = uiContract.colors.light

export const colors: ColorPalette = { ...darkColors }

function createNativeTheme(appearance: ResolvedTheme, palette: ColorPalette) {
  const dark = appearance === 'dark'
  return {
    appearance,
    bg: palette.background,
    border: palette.borderStrong,
    text: palette.text,
    textMuted: palette.textMuted,
    textFaint: palette.textFaint,
    textDim: palette.textMuted,
    accent: palette.primary,
    caret: palette.text,
    codeText: dark ? '#D7D7DC' : '#25262A',
    codeWash: palette.code,
    diffAdd: palette.diffAdd,
    diffDel: palette.diffDel,
    diffHunkBg: palette.diffHunkBg,
    fontSans: uiContract.typography.fontSans,
    fontMono: uiContract.typography.fontMono,
    syntax: dark ? {
      comment: '#73737B', keyword: '#FF7AB2', string: '#A8CC8C', number: '#C7A0F8', boolean: '#79B8FF', typeName: '#E8B17A',
      constructor: '#E8B17A', function: '#C7A0F8', property: '#79B8FF', variable: '#E8E8EB', operator: '#FF7AB2', punctuation: '#A0A0A8',
    } : {
      comment: '#6F7077', keyword: '#A6266E', string: '#3A6F2C', number: '#6F42C1', boolean: '#145DA0', typeName: '#9A4A00',
      constructor: '#9A4A00', function: '#6F42C1', property: '#145DA0', variable: '#25262A', operator: '#A6266E', punctuation: '#5D5E64',
    },
    metrics: {
      codeTextSize: 12, codeLineHeight: 19, mdCodeRadius: 9, mdCodePaddingX: 12, mdCodePaddingY: 10, mdTextSize: 14, mdLineHeight: 22,
      mdBlockGap: 12, mdHeadingSizes: [20, 16, 14, 14], mdHeadingLineHeights: [28, 24, 22, 22], diffTextSize: 12, diffLineHeight: 19,
      diffFileHeaderHeight: 34,
    },
  }
}

export interface InterfaceFonts {
  readonly fontSans: string
  readonly fontMono: string
}

export const DEFAULT_INTERFACE_FONTS: InterfaceFonts = Object.freeze({
  fontSans: uiContract.typography.fontSans,
  fontMono: uiContract.typography.fontMono,
})

const themeListeners = new Set<() => void>()
const subscribeTheme = (listener: () => void) => {
  themeListeners.add(listener)
  return () => { themeListeners.delete(listener) }
}
const getNativeTheme = () => nativeTheme

// Memoized rows must repaint typography without remounting their local state.
export function useNativeTheme() {
  return useSyncExternalStore(subscribeTheme, getNativeTheme, getNativeTheme)
}

export let nativeTheme = createNativeTheme('dark', darkColors)

export function applyResolvedTheme(appearance: ResolvedTheme, fonts: InterfaceFonts = DEFAULT_INTERFACE_FONTS): void {
  const palette = appearance === 'light' ? lightColors : darkColors
  Object.assign(colors, palette)
  nativeTheme = { ...createNativeTheme(appearance, palette), ...fonts }
  for (const listener of themeListeners) listener()
}
