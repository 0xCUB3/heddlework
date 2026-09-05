import { expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

it('renders only session titles, never long first-prompt previews', async () => {
  const source = await readFile(resolve(import.meta.dir, '../src/web/sessions.tsx'), 'utf8')
  expect(source).toContain('<strong>{title}</strong>')
  expect(source).toContain('session.name || session.title')
  expect(source).toContain('aria-current={active ? \'page\' : undefined}')
  expect(source).not.toContain('<strong>{session.firstMessage}</strong>')
})
