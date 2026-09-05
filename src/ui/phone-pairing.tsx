import React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qrPng, qrRasterSize, tryEncodeQrMatrix } from '../web/qr.ts'
import { colors } from './theme.ts'

const MODULE = 4
const QUIET = 4

function pairingQrPath(url: string): string {
  const directory = join(tmpdir(), 'heddlework-phone-qr')
  mkdirSync(directory, { recursive: true })
  let hash = 2166136261
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const path = join(directory, `${(hash >>> 0).toString(16)}.png`)
  writeFileSync(path, qrPng(url, MODULE))
  return path
}

export function PhonePairingQr({ url }: { url: string }) {
  const matrix = tryEncodeQrMatrix(url)
  if (!matrix) {
    return (
      <div testId="settings-phone-qr-fallback" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 13 }}>
        <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>Phone QR</text>
        <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 16 }}>This link is too long to encode as a QR code. Copy the phone link instead.</text>
      </div>
    )
  }
  const dim = qrRasterSize(matrix.length, MODULE, QUIET)
  const path = pairingQrPath(url)
  return (
    <div testId="settings-phone-qr" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, backgroundColor: '#ffffff' }}>
      <div testId="settings-phone-qr-image" style={{ width: dim, height: dim, flexShrink: 0, backgroundColor: '#ffffff' }}>
        {React.createElement('img', {
          src: path,
          alt: 'Phone pairing QR',
          objectFit: 'contain',
          style: { width: dim, height: dim },
        } as never)}
      </div>
      <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <text style={{ color: '#111111', fontSize: 12, fontWeight: 650 }}>Scan with the iOS app</text>
        <text style={{ color: '#444444', fontSize: 11, lineHeight: 16 }}>Point the Heddlework camera at this code. The token stays on this Mac; the code is generated offline.</text>
      </div>
    </div>
  )
}
