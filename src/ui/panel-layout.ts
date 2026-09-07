export interface PanelSizes { sidebar?: number; right?: number; terminal?: number }
export interface LayoutStorage { read(): PanelSizes; write(sizes: PanelSizes): void }
export type ResizePanel = 'sidebar' | 'right' | 'terminal'
export function clampPanelSize(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.max(1, Math.min(Math.max(minimum, value), maximum)))
}
export function parsePanelSizes(value: unknown): PanelSizes {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  const result: PanelSizes = {}
  for (const key of ['sidebar', 'right', 'terminal'] as const) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) result[key] = Math.round(value)
  }
  return result
}
export function draggedPanelSize(panel: ResizePanel, initial: number, delta: number, maximum: number): number {
  const minimum = panel === 'sidebar' ? 220 : panel === 'right' ? 320 : 140
  return clampPanelSize(initial + (panel === 'sidebar' ? delta : -delta), minimum, maximum)
}
