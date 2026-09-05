import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webBuildHash } from '../scripts/web-build-hash.ts'

test('web cache version changes with UI bytes, not just filenames', () => {
  const directory = mkdtempSync(join(tmpdir(), 'heddlework-build-hash-'))
  try {
    writeFileSync(join(directory, 'main.js'), 'old UI')
    writeFileSync(join(directory, 'styles.css'), 'old theme')
    const before = webBuildHash(directory, ['main.js', 'styles.css'])
    expect(webBuildHash(directory, ['styles.css', 'main.js'])).toBe(before)
    writeFileSync(join(directory, 'main.js'), 'new UI')
    expect(webBuildHash(directory, ['main.js', 'styles.css'])).not.toBe(before)
    const scriptChanged = webBuildHash(directory, ['main.js', 'styles.css'])
    writeFileSync(join(directory, 'styles.css'), 'new theme')
    expect(webBuildHash(directory, ['main.js', 'styles.css'])).not.toBe(scriptChanged)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
