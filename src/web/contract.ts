import uiContract from '../workbench/ui-contract.json'

export type WebSurface = (typeof uiContract.surfaces)[number]['id']
export type WebPanel = (typeof uiContract.panels)[number]['id']
export type WebSettingsSection = (typeof uiContract.settings)[number]['id']

export const webUiContract = uiContract

export function surfaceLabel(id: WebSurface): string {
  return uiContract.surfaces.find((surface) => surface.id === id)?.label ?? id
}

export function panelLabel(id: WebPanel): string {
  return uiContract.panels.find((panel) => panel.id === id)?.label ?? id
}

export function settingsLabel(id: WebSettingsSection): string {
  return uiContract.settings.find((section) => section.id === id)?.label ?? id
}

export function isMobileWidth(width: number): boolean {
  return width < uiContract.layout.mobileBreakpoint
}
