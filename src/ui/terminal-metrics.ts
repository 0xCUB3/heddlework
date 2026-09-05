export const TERMINAL_FONT_SIZE = 13
export const TERMINAL_LINE_HEIGHT = 17
// Menlo 13 px advances by 7.83 logical pixels in GPUI. Keep PTY sizing and
// forced-cell native shaping on the same fractional grid to prevent edge drift.
export const TERMINAL_CELL_WIDTH = 7.83
export const TERMINAL_PADDING_X = 8
export const TERMINAL_PADDING_Y = 6
export const TERMINAL_DOCK_DEFAULT_HEIGHT = 240
export const TERMINAL_DOCK_MIN_HEIGHT = 140
export const TERMINAL_DOCK_HEADER = 36
export const TERMINAL_DOCK_RESIZE = 8

export function terminalGridSize(width: number, height: number): { cols: number; rows: number } {
  const cols = Math.max(2, Math.floor(Math.max(0, width - TERMINAL_PADDING_X * 2) / TERMINAL_CELL_WIDTH))
  const rows = Math.max(1, Math.floor(Math.max(0, height - TERMINAL_PADDING_Y * 2) / TERMINAL_LINE_HEIGHT))
  return { cols, rows }
}
