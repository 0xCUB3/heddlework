import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// Rasterizes media/heddlework-icon.svg into every platform's native icon format. Runs on macOS only (it uses sips and
// iconutil); the outputs are committed so CI on other platforms just consumes them.
//
//   packaging/macos/Heddlework.icns                          macOS app bundle
//   packaging/windows/heddlework.ico                          Windows executable resource (bun build compile.windows.icon)
//   packaging/linux/icons/<size>.png                          hicolor PNG set for deb and rpm
//   src/web/icon-192.png, src/web/icon-512.png                PWA manifest
//   packaging/ios/.../AppIcon.appiconset/icon-1024.png        iOS asset catalog

const root = resolve(import.meta.dir, '..')
const source = resolve(root, 'media', 'heddlework-icon.svg')
const scratch = mkdtempSync(resolve(tmpdir(), 'heddlework-icons-'))

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: 'ignore', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString()}`)
}

// sips renders SVG through the system rasterizer; render each size directly from the vector rather than downscaling.
function png(size: number): string {
  const output = resolve(scratch, `icon-${size}.png`)
  run(['sips', '-s', 'format', 'png', '-z', String(size), String(size), source, '--out', output])
  return output
}

function copy(from: string, to: string): void {
  mkdirSync(resolve(to, '..'), { recursive: true })
  writeFileSync(to, readFileSync(from))
}

// ICO container with PNG-compressed entries, which Windows has accepted since Vista.
function ico(sizes: number[]): Buffer {
  const images = sizes.map((size) => ({ size, data: readFileSync(png(size)) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length
  images.forEach((image, index) => {
    const entry = index * 16
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry)
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1)
    directory.writeUInt8(0, entry + 2)
    directory.writeUInt8(0, entry + 3)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(image.data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.data.length
  })
  return Buffer.concat([header, directory, ...images.map((image) => image.data)])
}

try {
  // macOS: iconutil wants an .iconset folder with Apple's fixed names.
  const iconset = resolve(scratch, 'Heddlework.iconset')
  mkdirSync(iconset)
  for (const [name, size] of [
    ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
    ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
    ['icon_512x512', 512], ['icon_512x512@2x', 1024],
  ] as const) {
    copy(png(size), resolve(iconset, `${name}.png`))
  }
  run(['iconutil', '-c', 'icns', iconset, '-o', resolve(root, 'packaging', 'macos', 'Heddlework.icns')])
  console.log('packaging/macos/Heddlework.icns')

  const icoPath = resolve(root, 'packaging', 'windows', 'heddlework.ico')
  mkdirSync(resolve(icoPath, '..'), { recursive: true })
  writeFileSync(icoPath, ico([16, 24, 32, 48, 64, 128, 256]))
  console.log('packaging/windows/heddlework.ico')

  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    copy(png(size), resolve(root, 'packaging', 'linux', 'icons', `${size}.png`))
  }
  copy(source, resolve(root, 'packaging', 'linux', 'icons', 'heddlework-icon.svg'))
  console.log('packaging/linux/icons/{16..512}.png and heddlework-icon.svg')

  copy(png(192), resolve(root, 'src', 'web', 'icon-192.png'))
  copy(png(512), resolve(root, 'src', 'web', 'icon-512.png'))
  console.log('src/web/icon-192.png, src/web/icon-512.png')

  // iOS forbids alpha in the marketing icon; flatten onto the icon's own background colour.
  const ios = resolve(root, 'packaging', 'ios', 'Heddlework', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png')
  // iOS applies its own corner mask, so the marketing icon is the tile scaled to the full square with no shadow or margin.
  // sips cannot drop alpha in place; rendering the full-bleed variant through JPEG at maximum quality flattens it.
  const fullBleed = resolve(scratch, 'ios.svg')
  writeFileSync(fullBleed, readFileSync(source, 'utf8')
    .replace('<g filter="url(#shadow)">', '<g>')
    .replace(/viewBox="0 0 512 512"/, 'viewBox="28 28 456 456"'))
  const flat = resolve(scratch, 'ios.jpg')
  run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '100', '-z', '1024', '1024', fullBleed, '--out', flat])
  run(['sips', '-s', 'format', 'png', flat, '--out', ios])
  console.log('packaging/ios/.../icon-1024.png')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
