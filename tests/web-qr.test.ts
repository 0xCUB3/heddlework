import { describe, expect, it } from 'bun:test'
import { encodeQrMatrix, qrPng, qrRasterSize, qrSvg, tryEncodeQrMatrix } from '../src/web/qr.ts'

// Version 1, EC level M, byte mode for "HELLO WORLD", selected mask from the encoder.
const HELLO_WORLD_V1_M = [
  [1,1,1,1,1,1,1,0,1,1,0,0,1,0,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,1,0,0,0,0,1,0,0,1,0,0,0,0,0,1],
  [1,0,1,1,1,0,1,0,0,1,0,1,0,0,1,0,1,1,1,0,1],
  [1,0,1,1,1,0,1,0,1,0,0,1,0,0,1,0,1,1,1,0,1],
  [1,0,1,1,1,0,1,0,1,1,1,0,1,0,1,0,1,1,1,0,1],
  [1,0,0,0,0,0,1,0,1,0,0,1,0,0,1,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,0,1,0,1,0,1,0,1,1,1,1,1,1,1],
  [0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,0,0,0,0,0,0],
  [1,0,0,0,1,0,1,1,1,1,1,1,0,1,1,1,1,1,0,0,1],
  [0,0,0,1,0,0,0,0,1,0,1,1,1,0,0,0,0,1,1,1,1],
  [0,0,1,1,1,1,1,1,0,0,1,1,0,1,1,0,1,0,0,1,0],
  [1,1,1,1,1,0,0,0,1,1,0,0,0,1,0,0,0,0,0,0,0],
  [1,1,1,1,1,0,1,0,1,0,1,0,1,0,1,1,0,0,1,1,0],
  [0,0,0,0,0,0,0,0,1,0,1,0,1,1,1,1,0,1,0,1,1],
  [1,1,1,1,1,1,1,0,1,1,1,0,1,0,1,0,1,1,0,1,0],
  [1,0,0,0,0,0,1,0,0,1,0,1,1,1,0,1,1,0,0,1,1],
  [1,0,1,1,1,0,1,0,1,1,0,1,0,1,1,0,0,0,1,1,0],
  [1,0,1,1,1,0,1,0,0,1,0,0,1,0,0,0,1,1,0,1,1],
  [1,0,1,1,1,0,1,0,0,1,1,1,0,0,0,1,1,1,0,0,0],
  [1,0,0,0,0,0,1,0,0,0,0,1,0,1,0,0,0,0,0,0,0],
  [1,1,1,1,1,1,1,0,1,1,1,1,1,1,1,1,1,0,1,0,1],
]

describe('QR encoder', () => {
  it('matches the version 1 M matrix for HELLO WORLD', () => {
    const matrix = encodeQrMatrix('HELLO WORLD')
    expect(matrix).toEqual(HELLO_WORLD_V1_M)
    expect(matrix[0]!.slice(0, 7)).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(qrSvg('HELLO WORLD')).toContain('<svg')
  })

  it('encodes a host connect link with quiet zone and high-contrast modules', () => {
    const url = 'http://100.101.102.103:4817/?token=abcdefghijklmnopqrstuvwxyz0123456789-_'
    const matrix = encodeQrMatrix(url)
    expect(tryEncodeQrMatrix(url)).toEqual(matrix)
    expect(matrix[0]!.slice(0, 7)).toEqual([1, 1, 1, 1, 1, 1, 1])
    const svg = qrSvg(url, 4)
    expect(svg).toContain('fill="#fff"')
    expect(svg).toContain('shape-rendering="crispEdges"')
    const quiet = 4
    const module = 4
    const size = (matrix.length + quiet * 2) * module
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`)
    const png = qrPng(url, 4)
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(png.length).toBeGreaterThan(200)
    expect(qrRasterSize(matrix.length, 4, 4)).toBe(size)
  })
})
