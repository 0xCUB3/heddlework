// Browser PhonePairingQr: the QR is drawn as an inline SVG data URL instead of a temp PNG file.

import React from 'react'
import { qrRasterSize, tryEncodeQrMatrix } from '../../web/qr.ts'
import { colors } from '../../ui/theme.ts'

const MODULE = 4
const QUIET = 4

function qrSvg(matrix: ReadonlyArray<ReadonlyArray<number | boolean>>): string {
  const size = matrix.length + QUIET * 2
  const rects = matrix.flatMap((row, y) => row.flatMap((on, x) => on ? [`<rect x="${x + QUIET}" y="${y + QUIET}" width="1" height="1"/>`] : []))
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`)}`
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
  return (
    <div testId="settings-phone-qr" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, backgroundColor: '#ffffff' }}>
      <div testId="settings-phone-qr-image" style={{ width: dim, height: dim, flexShrink: 0, backgroundColor: '#ffffff' }}>
        {React.createElement('img', { src: qrSvg(matrix), alt: 'Phone pairing QR', objectFit: 'contain', style: { width: dim, height: dim } } as never)}
      </div>
      <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <text style={{ color: '#111111', fontSize: 12, fontWeight: 650 }}>Scan with the iOS app</text>
        <text style={{ color: '#444444', fontSize: 11, lineHeight: 16 }}>Point the Heddlework camera at this code. The token stays on the host; the code is generated offline.</text>
      </div>
    </div>
  )
}
