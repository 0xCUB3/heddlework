export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export interface Lab {
  readonly l: number
  readonly a: number
  readonly b: number
}

interface Xyz {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface TerminalPaletteAnchors {
  readonly background: string
  readonly foreground: string
  readonly red: string
  readonly green: string
  readonly yellow: string
  readonly blue: string
  readonly magenta: string
  readonly cyan: string
}

const SRGB_THRESHOLD = 0.04045
const SRGB_LINEAR_THRESHOLD = 0.0031308
const D65_X = 0.95047
const D65_Y = 1
const D65_Z = 1.08883
const CIE_KAPPA = 24389 / 27
const CIE_EPSILON = 216 / 24389
const MAX_LAB_CHANNEL = 1e100

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function srgbToLinearByte(channel: number): number {
  const normalized = clampByte(channel) / 255
  return normalized <= SRGB_THRESHOLD
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4)
}

function linearToSrgbByte(channel: number): number {
  if (channel <= 0) return 0
  if (channel >= 1) return 255
  const normalized = channel <= SRGB_LINEAR_THRESHOLD
    ? 12.92 * channel
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055
  return Math.round(normalized * 255)
}

export function parseHexColor(color: string): Rgb {
  const cleaned = color.trim().replace(/^#/u, '')
  const digits = cleaned.length >= 6
    ? cleaned.slice(0, 6)
    : cleaned.slice(0, 3).split('').map((digit) => digit + digit).join('')
  if (!/^[0-9a-f]{6}$/iu.test(digits)) return { r: 0, g: 0, b: 0 }
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  }
}

export function rgbToHex(rgb: Rgb): string {
  return `#${[rgb.r, rgb.g, rgb.b].map((channel) => clampByte(channel).toString(16).padStart(2, '0')).join('')}`
}

export function relativeLuminance(color: string | Rgb): number {
  const rgb = typeof color === 'string' ? parseHexColor(color) : color
  return 0.2126 * srgbToLinearByte(rgb.r)
    + 0.7152 * srgbToLinearByte(rgb.g)
    + 0.0722 * srgbToLinearByte(rgb.b)
}

export function contrastRatio(left: string | Rgb, right: string | Rgb): number {
  const leftLuminance = relativeLuminance(left)
  const rightLuminance = relativeLuminance(right)
  const light = Math.max(leftLuminance, rightLuminance)
  const dark = Math.min(leftLuminance, rightLuminance)
  return (light + 0.05) / (dark + 0.05)
}

export function blendLinear(background: string | Rgb, foreground: string | Rgb, opacity: number): string {
  const bg = typeof background === 'string' ? parseHexColor(background) : background
  const fg = typeof foreground === 'string' ? parseHexColor(foreground) : foreground
  const alpha = Math.max(0, Math.min(1, opacity))
  return rgbToHex({
    r: linearToSrgbByte(srgbToLinearByte(fg.r) * alpha + srgbToLinearByte(bg.r) * (1 - alpha)),
    g: linearToSrgbByte(srgbToLinearByte(fg.g) * alpha + srgbToLinearByte(bg.g) * (1 - alpha)),
    b: linearToSrgbByte(srgbToLinearByte(fg.b) * alpha + srgbToLinearByte(bg.b) * (1 - alpha)),
  })
}

export function ensureContrast(background: string, foreground: string, minimumRatio: number): string {
  if (minimumRatio <= 1 || contrastRatio(background, foreground) >= minimumRatio) return rgbToHex(parseHexColor(foreground))
  const source = parseHexColor(foreground)
  const black: Rgb = { r: 0, g: 0, b: 0 }
  const white: Rgb = { r: 255, g: 255, b: 255 }
  const target = contrastRatio(background, black) >= contrastRatio(background, white) ? black : white
  if (contrastRatio(background, target) < minimumRatio) return rgbToHex(target)
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const amount = (low + high) / 2
    const candidate = mixLinearRgb(source, target, amount)
    if (contrastRatio(background, candidate) >= minimumRatio) high = amount
    else low = amount
  }
  return rgbToHex(mixLinearRgb(source, target, high))
}

function mixLinearRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: linearToSrgbByte(srgbToLinearByte(from.r) + (srgbToLinearByte(to.r) - srgbToLinearByte(from.r)) * amount),
    g: linearToSrgbByte(srgbToLinearByte(from.g) + (srgbToLinearByte(to.g) - srgbToLinearByte(from.g)) * amount),
    b: linearToSrgbByte(srgbToLinearByte(from.b) + (srgbToLinearByte(to.b) - srgbToLinearByte(from.b)) * amount),
  }
}

export function rgbToLab(rgb: Rgb): Lab {
  return xyzToLab(rgbToXyz(rgb))
}

export function labToRgb(lab: Lab): Rgb {
  return xyzToRgb(labToXyz(lab))
}

function rgbToXyz(rgb: Rgb): Xyz {
  const r = srgbToLinearByte(rgb.r)
  const g = srgbToLinearByte(rgb.g)
  const b = srgbToLinearByte(rgb.b)
  return {
    x: 0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    y: 0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    z: 0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  }
}

function xyzToRgb(xyz: Xyz): Rgb {
  return {
    r: linearToSrgbByte(3.2404542 * xyz.x - 1.5371385 * xyz.y - 0.4985314 * xyz.z),
    g: linearToSrgbByte(-0.969266 * xyz.x + 1.8760108 * xyz.y + 0.041556 * xyz.z),
    b: linearToSrgbByte(0.0556434 * xyz.x - 0.2040259 * xyz.y + 1.0572252 * xyz.z),
  }
}

function xyzToLab(xyz: Xyz): Lab {
  const transform = (channel: number) => channel > 0.008856 ? Math.cbrt(channel) : 7.787 * channel + 16 / 116
  const x = transform(xyz.x / D65_X)
  const y = transform(xyz.y / D65_Y)
  const z = transform(xyz.z / D65_Z)
  return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) }
}

function labToXyz(lab: Lab): Xyz {
  const y = (lab.l + 16) / 116
  const x = lab.a / 500 + y
  const z = y - lab.b / 200
  const transform = (value: number) => {
    const bounded = Math.max(-MAX_LAB_CHANNEL, Math.min(MAX_LAB_CHANNEL, value))
    const cube = bounded * bounded * bounded
    return cube > CIE_EPSILON ? cube : (116 * bounded - 16) / CIE_KAPPA
  }
  return { x: D65_X * transform(x), y: D65_Y * transform(y), z: D65_Z * transform(z) }
}

function interpolateLab(amount: number, from: Lab, to: Lab): Lab {
  return {
    l: from.l + amount * (to.l - from.l),
    a: from.a + amount * (to.a - from.a),
    b: from.b + amount * (to.b - from.b),
  }
}

export function generateExtendedPalette(colors: TerminalPaletteAnchors, harmonious = false): string[] {
  const base = [
    rgbToLab(parseHexColor(colors.background)),
    rgbToLab(parseHexColor(colors.red)),
    rgbToLab(parseHexColor(colors.green)),
    rgbToLab(parseHexColor(colors.yellow)),
    rgbToLab(parseHexColor(colors.blue)),
    rgbToLab(parseHexColor(colors.magenta)),
    rgbToLab(parseHexColor(colors.cyan)),
    rgbToLab(parseHexColor(colors.foreground)),
  ]
  const lightTheme = base[7]!.l < base[0]!.l
  if (lightTheme && !harmonious) [base[0], base[7]] = [base[7]!, base[0]!]
  const palette: string[] = []
  for (let red = 0; red < 6; red += 1) {
    const corner0 = interpolateLab(red / 5, base[0]!, base[1]!)
    const corner1 = interpolateLab(red / 5, base[2]!, base[3]!)
    const corner2 = interpolateLab(red / 5, base[4]!, base[5]!)
    const corner3 = interpolateLab(red / 5, base[6]!, base[7]!)
    for (let green = 0; green < 6; green += 1) {
      const middle0 = interpolateLab(green / 5, corner0, corner1)
      const middle1 = interpolateLab(green / 5, corner2, corner3)
      for (let blue = 0; blue < 6; blue += 1) {
        palette.push(rgbToHex(labToRgb(interpolateLab(blue / 5, middle0, middle1))))
      }
    }
  }
  for (let shade = 0; shade < 24; shade += 1) {
    palette.push(rgbToHex(labToRgb(interpolateLab((shade + 1) / 25, base[0]!, base[7]!))))
  }
  return palette
}
