import { expect, it } from 'bun:test'
import { lightColors, darkColors } from '../src/ui/theme.ts'
import { contrastRatio } from '../src/ui/terminal-color.ts'

for (const [name, palette] of Object.entries({ light: lightColors, dark: darkColors })) {
  it(`${name} selection has readable labels and a distinct fill without bold text`, () => {
    expect(contrastRatio(palette.sidebarActive, palette.text)).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(palette.sidebarActive, palette.sidebarActiveMuted)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(palette.sidebarActive, palette.sidebar)).toBeGreaterThan(1.15)
    expect(palette.sidebarHover).not.toBe(palette.sidebarActive)
  })
}
