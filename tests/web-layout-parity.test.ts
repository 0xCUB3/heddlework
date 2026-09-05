import { expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

it('keeps native session-card markup without first-prompt bodies', async () => {
  const source = await readFile(resolve(import.meta.dir, '../src/web/sessions.tsx'), 'utf8')
  expect(source).toContain('web-session-card')
  expect(source).toContain('web-session-project')
  expect(source).toContain('web-session-branch')
  expect(source).toContain('web-session-card-active')
  expect(source).toContain('<strong>{title}</strong>')
  expect(source).not.toContain('<strong>{session.firstMessage}</strong>')
})

it('places the branch context strip below the composer surface', async () => {
  const source = await readFile(resolve(import.meta.dir, '../src/web/composer.tsx'), 'utf8')
  expect(source).toContain('web-composer-context')
  expect(source).toContain('Local checkout')
  expect(source.indexOf('web-composer-surface')).toBeLessThan(source.indexOf('web-composer-context'))
})
