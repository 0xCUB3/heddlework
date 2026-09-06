import React from 'react'
import { describe, expect, it } from 'bun:test'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { phonePairingLink, preferredPairingLink } from '../src/host/server.ts'
import { PhonePairingQr } from '../src/ui/phone-pairing.tsx'
import { encodeQrMatrix, qrPng, tryQrSvg } from '../src/web/qr.ts'

const testNative = hasNativeTestRenderer ? it : it.skip
const FIXTURE_URL = 'http://192.168.1.20:4817/?token=phone-link-token'
const DECODE_SCRIPT = join(import.meta.dir, '../scripts/validation/decode-qr.swift')

function decodeQr(imagePath: string): string {
  const result = Bun.spawnSync(['swift', DECODE_SCRIPT, imagePath], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`QR decode failed (${result.exitCode}): ${result.stderr.toString() || result.stdout.toString()}`)
  }
  return result.stdout.toString().trim()
}

describe('phone pairing QR', () => {
  it('does not advertise a loopback host as a scannable phone link', () => {
    expect(phonePairingLink({ hostname: '127.0.0.1', port: 4817, token: 'abc', url: 'http://127.0.0.1:4817' })).toBeUndefined()
    expect(phonePairingLink({ hostname: 'localhost', port: 4817, token: 'abc', url: 'http://127.0.0.1:4817' })).toBeUndefined()
    expect(preferredPairingLink({ hostname: '127.0.0.1', port: 4817, token: 'abc', url: 'http://127.0.0.1:4817' }, 'https://mac.tailnet.ts.net:8443')).toBe('https://mac.tailnet.ts.net:8443/?token=abc')
  })

  it('round-trips a Tailscale connect URL through the offline encoder', () => {
    const url = 'http://100.101.102.103:4817/?token=abcdefghijklmnopqrstuvwxyz0123456789-_'
    const svg = tryQrSvg(url)
    expect(svg).toContain('<svg')
    expect(svg).toContain('fill="#fff"')
    expect(encodeQrMatrix(url).length).toBeGreaterThanOrEqual(21)
  })

  it('decodes an offline PNG of the fixture phone link', () => {
    const directory = join(tmpdir(), 'heddlework-phone-qr')
    mkdirSync(directory, { recursive: true })
    const pngPath = join(directory, 'fixture-phone-link.png')
    writeFileSync(pngPath, qrPng(FIXTURE_URL, 4))
    expect(decodeQr(pngPath)).toBe(FIXTURE_URL)
  }, { timeout: 20_000 })

  testNative('renders a high-contrast QR the iOS camera can scan', async () => {
    const root = createTestRoot({ width: 420, height: 280 })
    root.render(<PhonePairingQr url={FIXTURE_URL} />)
    const automation = await connectTest(root.renderer)
    try {
      root.renderer.flush()
      expect(await automation.getByTestId('settings-phone-qr').count()).toBe(1)
      expect(await automation.getByTestId('settings-phone-qr-image').count()).toBe(1)
      expect(root.renderer.getPaintedText()).toContain('Scan with the iOS app')
      if (process.platform === 'darwin') {
        const directory = join(tmpdir(), 'heddlework-phone-qr')
        mkdirSync(directory, { recursive: true })
        const screenshot = join(directory, 'settings-phone-qr.png')
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(1_000)
        expect(decodeQr(screenshot)).toBe(FIXTURE_URL)
      }
    } finally {
      await automation.close()
      root.unmount()
    }
  }, { timeout: 20_000 })
})
