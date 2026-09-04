import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCefArtifactInventory, verifyCefArtifactInventory } from '../scripts/cef-artifacts.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'darwin')('CEF artifact inventory', () => {
  test('rejects modified, missing, and extra files', () => {
    const root = fixture()
    const inventory = readCefArtifactInventory(root)
    expect(() => verifyCefArtifactInventory(root, inventory)).not.toThrow()

    writeFileSync(join(root, 'Framework.framework', 'Versions', 'A', 'Resources', 'pack.pak'), 'changed')
    expect(() => verifyCefArtifactInventory(root, inventory)).toThrow('does not match its manifest')

    rmSync(join(root, 'Framework.framework', 'Versions', 'A', 'Resources', 'pack.pak'))
    expect(() => verifyCefArtifactInventory(root, inventory)).toThrow('missing: Framework.framework/Versions/A/Resources/pack.pak')

    writeFileSync(join(root, 'unexpected.bin'), 'unsigned')
    expect(() => verifyCefArtifactInventory(root, inventory)).toThrow('extra: unexpected.bin')
  })

  test('rejects inherited-name extras and special permission changes', () => {
    const root = fixture()
    const inventory = readCefArtifactInventory(root)

    writeFileSync(join(root, 'constructor'), 'unexpected')
    expect(() => verifyCefArtifactInventory(root, inventory)).toThrow('extra: constructor')
    rmSync(join(root, 'constructor'))

    chmodSync(join(root, 'helper'), 0o4755)
    expect(() => verifyCefArtifactInventory(root, inventory)).toThrow('does not match its manifest: helper')
  })

  test('records contained symlinks and rejects escaping links', () => {
    const root = fixture()
    symlinkSync('Versions/A/Resources', join(root, 'Framework.framework', 'Resources'))
    const inventory = readCefArtifactInventory(root)
    expect(inventory['Framework.framework/Resources']).toEqual({ type: 'symlink', target: 'Versions/A/Resources' })
    expect(() => verifyCefArtifactInventory(root, inventory)).not.toThrow()

    symlinkSync('/tmp', join(root, 'escape'))
    expect(() => readCefArtifactInventory(root)).toThrow('symlink escapes its package root')
  })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'heddlework-cef-artifacts-'))
  roots.push(root)
  const resources = join(root, 'Framework.framework', 'Versions', 'A', 'Resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(resources, 'pack.pak'), 'verified')
  writeFileSync(join(root, 'helper'), 'executable', { mode: 0o755 })
  return root
}
