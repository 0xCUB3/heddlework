import { expect, it } from 'bun:test'
import { popupViewportShift } from '../src/dom/popup-position.ts'

it('keeps a left-clamped sidebar popup at a fixed point across repeated layouts', () => {
  const initial = { left: -38, right: 166, top: 75, bottom: 235 }
  const viewport = { width: 240, height: 500 }
  let applied = { x: 0, y: 0 }
  for (let frame = 0; frame < 100; frame++) {
    applied = popupViewportShift({ left: initial.left + applied.x, right: initial.right + applied.x, top: initial.top + applied.y, bottom: initial.bottom + applied.y }, viewport, 8, applied)
    expect(applied).toEqual({ x: 46, y: 0 })
  }
})

it('clamps right and bottom edges and releases the correction when the anchor moves', () => {
  expect(popupViewportShift({ left: 200, right: 404, top: 440, bottom: 600 }, { width: 320, height: 500 }, 8, { x: 0, y: 0 })).toEqual({ x: -92, y: -108 })
  expect(popupViewportShift({ left: 16, right: 220, top: 24, bottom: 184 }, { width: 320, height: 500 }, 8, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
})
