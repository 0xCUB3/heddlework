import { expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer } from '../src/web/composer.tsx'
import { Sessions } from '../src/web/sessions.tsx'
import { createInitialState } from '../src/workbench/state.ts'

it('renders 78px title-only session cards with project and branch, never first-prompt previews', () => {
  const state = createInitialState('/workspace')
  state.workspaceDiff.branch = 'main'
  state.sessions = [{
    id: 'one',
    path: '/session.jsonl',
    cwd: '/workspace',
    title: 'Fallback title',
    name: 'Fix login',
    firstMessage: 'Private lengthy prompt that must not appear below the title. '.repeat(50),
    messageCount: 4,
    createdAt: 1,
    modifiedAt: Date.now(),
  }]
  state.session.sessionFile = '/session.jsonl'
  const html = renderToStaticMarkup(createElement(Sessions, { state }))
  expect(html).toContain('<strong>Fix login</strong>')
  expect(html).toContain('web-session-card')
  expect(html).toContain('web-session-project')
  expect(html).toContain('web-session-branch')
  expect(html).toContain('main')
  expect(html).not.toContain('Private lengthy prompt')
  expect(html).not.toContain('web-meta')
  expect(html).not.toContain('Fallback title')
  expect(html).toContain('aria-current="page"')
})

it('places the branch context strip below the composer surface', () => {
  const state = createInitialState('/workspace')
  state.workspaceDiff.branch = 'feature/layout'
  const html = renderToStaticMarkup(createElement(Composer, { state, hero: true }))
  expect(html).toContain('web-composer-context')
  expect(html).toContain('Local checkout')
  expect(html).toContain('feature/layout')
  expect(html.indexOf('web-composer-surface')).toBeLessThan(html.indexOf('web-composer-context'))
})
