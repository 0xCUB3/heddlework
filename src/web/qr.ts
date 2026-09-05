// Byte-mode QR, EC level M, versions 1 to 10. Used for host connect links.

const EC_M = 0
const PAD = [0xec, 0x11]

interface VersionSpec {
  version: number
  size: number
  total: number
  data: number
  blocks: Array<{ count: number; data: number; ec: number }>
  align: number[]
  byteCapacity: number
}

const VERSIONS: VersionSpec[] = [
  { version: 1, size: 21, total: 26, data: 16, blocks: [{ count: 1, data: 16, ec: 10 }], align: [], byteCapacity: 14 },
  { version: 2, size: 25, total: 44, data: 28, blocks: [{ count: 1, data: 28, ec: 16 }], align: [18], byteCapacity: 26 },
  { version: 3, size: 29, total: 70, data: 44, blocks: [{ count: 1, data: 44, ec: 26 }], align: [22], byteCapacity: 42 },
  { version: 4, size: 33, total: 100, data: 64, blocks: [{ count: 2, data: 32, ec: 18 }], align: [26], byteCapacity: 62 },
  { version: 5, size: 37, total: 134, data: 86, blocks: [{ count: 2, data: 43, ec: 24 }], align: [30], byteCapacity: 84 },
  { version: 6, size: 41, total: 172, data: 108, blocks: [{ count: 4, data: 27, ec: 16 }], align: [34], byteCapacity: 106 },
  { version: 7, size: 45, total: 196, data: 124, blocks: [{ count: 4, data: 31, ec: 18 }], align: [22, 38], byteCapacity: 122 },
  { version: 8, size: 49, total: 242, data: 154, blocks: [{ count: 2, data: 38, ec: 22 }, { count: 2, data: 39, ec: 22 }], align: [24, 42], byteCapacity: 152 },
  { version: 9, size: 53, total: 292, data: 182, blocks: [{ count: 3, data: 36, ec: 22 }, { count: 2, data: 37, ec: 22 }], align: [26, 46], byteCapacity: 180 },
  { version: 10, size: 57, total: 346, data: 216, blocks: [{ count: 4, data: 43, ec: 26 }, { count: 1, data: 44, ec: 26 }], align: [28, 50], byteCapacity: 213 },
]

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let value = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = value
    LOG[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a]! + LOG[b]!]!
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root)
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!
    }
    root = gfMul(root, 2)
  }
  return result
}

function rsEncode(data: number[], degree: number): number[] {
  const divisor = rsDivisor(degree)
  const ecc = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ ecc[0]!
    ecc.shift()
    ecc.push(0)
    if (factor === 0) continue
    for (let i = 0; i < degree; i++) ecc[i] = ecc[i]! ^ gfMul(divisor[i]!, factor)
  }
  return ecc
}

function chooseVersion(bytes: number): VersionSpec {
  const spec = VERSIONS.find((version) => version.byteCapacity >= bytes)
  if (!spec) throw new Error(`QR payload is too long for versions 1-10 (${bytes} bytes)`)
  return spec
}

function encodeData(text: string, spec: VersionSpec): number[] {
  const payload = [...new TextEncoder().encode(text)]
  const bits: number[] = []
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  push(0b0100, 4)
  push(payload.length, spec.version >= 10 ? 16 : 8)
  for (const byte of payload) push(byte, 8)
  const capacity = spec.data * 8
  const terminator = Math.min(4, capacity - bits.length)
  push(0, terminator)
  while (bits.length % 8 !== 0) bits.push(0)
  const bytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j++) value = (value << 1) | (bits[i + j] ?? 0)
    bytes.push(value)
  }
  let pad = 0
  while (bytes.length < spec.data) {
    bytes.push(PAD[pad % 2]!)
    pad++
  }
  return bytes
}

function interleave(data: number[], spec: VersionSpec): number[] {
  const blocks: Array<{ data: number[]; ec: number[] }> = []
  let offset = 0
  for (const group of spec.blocks) {
    for (let i = 0; i < group.count; i++) {
      const slice = data.slice(offset, offset + group.data)
      offset += group.data
      blocks.push({ data: slice, ec: rsEncode(slice, group.ec) })
    }
  }
  const out: number[] = []
  const maxData = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      const value = block.data[i]
      if (value !== undefined) out.push(value)
    }
  }
  const maxEc = Math.max(...blocks.map((block) => block.ec.length))
  for (let i = 0; i < maxEc; i++) {
    for (const block of blocks) {
      const value = block.ec[i]
      if (value !== undefined) out.push(value)
    }
  }
  return out
}

function reserved(size: number, align: number[]): boolean[][] {
  const mark = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  const set = (y: number, x: number): void => {
    if (y >= 0 && y < size && x >= 0 && x < size) mark[y]![x] = true
  }
  const finder = (oy: number, ox: number): void => {
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) set(oy + y, ox + x)
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)
  for (let i = 8; i < size - 8; i++) {
    set(6, i)
    set(i, 6)
  }
  for (const row of [6, ...align]) {
    for (const col of [6, ...align]) {
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) set(row + y, col + x)
    }
  }
  for (let i = 0; i < 6; i++) {
    set(8, i)
    set(i, 8)
  }
  set(8, 7)
  set(8, 8)
  set(7, 8)
  for (let i = 0; i < 8; i++) set(8, size - 1 - i)
  for (let i = 0; i < 7; i++) set(size - 1 - i, 8)
  set(size - 8, 8)
  if (size >= 45) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      set(i, size - 11 + j)
      set(size - 11 + j, i)
    }
  }
  return mark
}

function placeFinders(modules: number[][], size: number): void {
  const paint = (oy: number, ox: number): void => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const edge = x === 0 || x === 6 || y === 0 || y === 6
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4
        modules[oy + y]![ox + x] = edge || core ? 1 : 0
      }
    }
  }
  paint(0, 0)
  paint(0, size - 7)
  paint(size - 7, 0)
}

function placeTiming(modules: number[][], size: number): void {
  for (let i = 8; i < size - 8; i++) {
    modules[6]![i] = i % 2 === 0 ? 1 : 0
    modules[i]![6] = i % 2 === 0 ? 1 : 0
  }
}

function placeAlign(modules: number[][], align: number[]): void {
  for (const row of align) {
    for (const col of align) {
      if ((row === 6 && col === 6) || (row === 6 && col === modules.length - 7) || (row === modules.length - 7 && col === 6)) continue
      for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
          modules[row + y]![col + x] = Math.max(Math.abs(x), Math.abs(y)) !== 1 ? 1 : 0
        }
      }
    }
  }
}

function versionBits(version: number): number {
  let bits = version << 12
  let poly = 0x1f25
  for (let i = 17; i >= 12; i--) {
    if ((bits >>> i) & 1) bits ^= poly << (i - 12)
  }
  return (version << 12) | bits
}

function placeVersion(modules: number[][], version: number): void {
  if (version < 7) return
  const bits = versionBits(version)
  const size = modules.length
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1
    const row = Math.floor(i / 3)
    const col = i % 3
    modules[row]![size - 11 + col] = bit
    modules[size - 11 + col]![row] = bit
  }
}

function maskFn(id: number, y: number, x: number): boolean {
  switch (id) {
    case 0: return (y + x) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (y + x) % 3 === 0
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5: return ((y * x) % 2) + ((y * x) % 3) === 0
    case 6: return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0
    default: return (((y * x) % 3) + ((y + x) % 2)) % 2 === 0
  }
}

function placeData(modules: number[][], reservedMap: boolean[][], data: number[]): void {
  const size = modules.length
  const bits: number[] = []
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  }
  let index = 0
  let up = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let row = 0; row < size; row++) {
      const y = up ? size - 1 - row : row
      for (const x of [col, col - 1]) {
        if (reservedMap[y]![x]) continue
        modules[y]![x] = bits[index] ?? 0
        index++
      }
    }
    up = !up
  }
}

function applyMask(modules: number[][], reservedMap: boolean[][], id: number): number[][] {
  return modules.map((row, y) => row.map((cell, x) => reservedMap[y]![x] ? cell : (maskFn(id, y, x) ? cell ^ 1 : cell)))
}

function formatBits(mask: number): number {
  const data = (EC_M << 3) | mask
  let bits = data << 10
  const poly = 0x537
  for (let i = 14; i >= 10; i--) {
    if ((bits >>> i) & 1) bits ^= poly << (i - 10)
  }
  return ((data << 10) | bits) ^ 0x5412
}

function placeFormat(modules: number[][], mask: number): void {
  const bits = formatBits(mask)
  const size = modules.length
  const positions: Array<[number, number]> = []
  for (let i = 0; i < 6; i++) positions.push([8, i])
  positions.push([8, 7], [8, 8], [7, 8])
  for (let i = 5; i >= 0; i--) positions.push([i, 8])
  for (let i = 0; i < 8; i++) modules[positions[i]![0]]![positions[i]![1]] = (bits >> (14 - i)) & 1
  for (let i = 0; i < 7; i++) modules[positions[8 + i]![0]]![positions[8 + i]![1]] = (bits >> (6 - i)) & 1
  for (let i = 0; i < 8; i++) modules[8]![size - 1 - i] = (bits >> i) & 1
  for (let i = 0; i < 7; i++) modules[size - 7 + i]![8] = (bits >> (8 + i)) & 1
  modules[size - 8]![8] = 1
}

function penalty(modules: number[][]): number {
  const size = modules.length
  let score = 0
  const addRuns = (get: (i: number, j: number) => number): void => {
    for (let i = 0; i < size; i++) {
      let color = get(i, 0)
      let run = 1
      for (let j = 1; j < size; j++) {
        const bit = get(i, j)
        if (bit === color) {
          run++
          if (run === 5) score += 3
          else if (run > 5) score += 1
        } else {
          color = bit
          run = 1
        }
      }
    }
  }
  addRuns((y, x) => modules[y]![x]!)
  addRuns((x, y) => modules[y]![x]!)
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y]![x]
      if (v === modules[y]![x + 1] && v === modules[y + 1]![x] && v === modules[y + 1]![x + 1]) score += 3
    }
  }
  const addFinder = (get: (i: number, j: number) => number): void => {
    for (let i = 0; i < size; i++) {
      let history = 0
      for (let j = 0; j < size; j++) {
        history = ((history << 1) & 0x7ff) | get(i, j)
        if (j >= 10 && (history === 0x05d || history === 0x5d0)) score += 40
      }
    }
  }
  addFinder((y, x) => modules[y]![x]!)
  addFinder((x, y) => modules[y]![x]!)
  const dark = modules.flat().reduce((sum, bit) => sum + bit, 0)
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  score += k * 10
  return score
}

export type QrMatrix = number[][]

export function encodeQrMatrix(text: string): QrMatrix {
  const spec = chooseVersion(new TextEncoder().encode(text).length)
  const reservedMap = reserved(spec.size, spec.align)
  const raw = Array.from({ length: spec.size }, () => Array.from({ length: spec.size }, () => 0))
  placeFinders(raw, spec.size)
  placeTiming(raw, spec.size)
  placeAlign(raw, spec.align)
  placeVersion(raw, spec.version)
  placeData(raw, reservedMap, interleave(encodeData(text, spec), spec))
  let best: QrMatrix | undefined
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(raw, reservedMap, mask)
    placeFormat(masked, mask)
    const score = penalty(masked)
    if (score < bestScore) {
      bestScore = score
      best = masked
    }
  }
  return best ?? raw
}

export function tryEncodeQrMatrix(text: string): QrMatrix | undefined {
  try {
    return encodeQrMatrix(text)
  } catch {
    return undefined
  }
}

export function qrSvg(text: string, module = 4): string {
  const matrix = encodeQrMatrix(text)
  const quiet = 4
  const size = (matrix.length + quiet * 2) * module
  const rects = matrix.flatMap((row, y) => row.flatMap((bit, x) => (
    bit ? `<rect x="${(x + quiet) * module}" y="${(y + quiet) * module}" width="${module}" height="${module}"/>` : []
  )))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/>${rects.join('')}</svg>`
}

export function tryQrSvg(text: string, module = 4): string | undefined {
  try {
    return qrSvg(text, module)
  } catch {
    return undefined
  }
}

export function qrAscii(text: string): string {
  const matrix = encodeQrMatrix(text)
  const pad = (row: number[]): number[] => [0, 0, ...row, 0, 0]
  const lines = [Array.from({ length: matrix.length + 4 }, () => 0), ...matrix.map(pad), Array.from({ length: matrix.length + 4 }, () => 0)]
  return lines.map((row) => row.map((bit) => (bit ? '██' : '  ')).join('')).join('\n')
}

export function qrRasterSize(matrixLength: number, module = 4, quiet = 4): number {
  return (matrixLength + quiet * 2) * module
}

// Uncompressed PNG so GPUix can paint a real image without a Node zlib import.
export function qrPng(text: string, module = 4): Uint8Array {
  const matrix = encodeQrMatrix(text)
  const quiet = 4
  const size = qrRasterSize(matrix.length, module, quiet)
  const stride = 1 + size * 3
  const raw = new Uint8Array(stride * size)
  for (let y = 0; y < size; y++) {
    const row = y * stride
    raw[row] = 0
    const my = Math.floor(y / module) - quiet
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / module) - quiet
      const on = my >= 0 && mx >= 0 && my < matrix.length && mx < matrix.length && matrix[my]![mx] === 1
      const px = row + 1 + x * 3
      const value = on ? 0x11 : 0xff
      raw[px] = value
      raw[px + 1] = value
      raw[px + 2] = value
    }
  }
  return encodePng(size, size, raw)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let crc = n
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    table[n] = crc >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a += byte
    if (a >= 65521) a -= 65521
    b += a
    if (b >= 65521) b -= 65521
  }
  return ((b << 16) | a) >>> 0
}

function u32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const body = concatBytes([typeBytes, data])
  return concatBytes([u32(data.length), body, u32(crc32(body))])
}

function zlibStore(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)]
  const max = 65535
  for (let offset = 0; offset < data.length; ) {
    const n = Math.min(max, data.length - offset)
    const last = offset + n >= data.length ? 1 : 0
    const header = Uint8Array.of(last, n & 0xff, (n >> 8) & 0xff, (~n) & 0xff, ((~n) >> 8) & 0xff)
    parts.push(header, data.subarray(offset, offset + n))
    offset += n
  }
  parts.push(u32(adler32(data)))
  return concatBytes(parts)
}

function encodePng(width: number, height: number, raw: Uint8Array): Uint8Array {
  const ihdr = concatBytes([u32(width), u32(height), Uint8Array.of(8, 2, 0, 0, 0)])
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
  return concatBytes([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibStore(raw)),
    pngChunk('IEND', new Uint8Array()),
  ])
}
