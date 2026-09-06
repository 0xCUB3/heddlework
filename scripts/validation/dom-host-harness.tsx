// Browser-side half of the DOM host probe: mounts WorkbenchApp against a fixture state and returns the HTML.

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installCreateElementBridge, GpuixContext, domRenderer } from '../../src/dom/host.tsx'
import { WorkbenchApp } from '../../src/ui/app.tsx'
import { createInitialState } from '../../src/workbench/state.ts'
import { WorkbenchUiRegistry } from '../../src/ui/extensions.ts'
import { PresenceRegistry } from '../../src/workbench/presence.ts'
import { allProjectionSnapshots } from '../../tests/fixtures/transcript-projection-cases.ts'

installCreateElementBridge()

let renders = 0
const startedAt = Date.now()
const counts = new Map<string, number>()
const RealReact = React as unknown as { __hwOrig?: typeof React.createElement }
const origCreate = React.createElement
;(React as { createElement: typeof React.createElement }).createElement = ((type: unknown, ...rest: unknown[]) => {
  const name = typeof type === 'function' ? (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name ?? 'anon' : String(type)
  counts.set(name, (counts.get(name) ?? 0) + 1)
  renders += 1
  if (Date.now() - startedAt > 8000) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    console.log('WATCHDOG renders', renders, JSON.stringify(top))
    console.log(new Error('watchdog').stack)
    throw new Error('watchdog')
  }
  if (renders % 20000 === 0) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    console.log('renders', renders, JSON.stringify(top))
  }
  if (renders === 200000) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    console.log('RENDER STORM', JSON.stringify(top))
    throw new Error('render storm')
  }
  return origCreate(type as never, ...(rest as never[]))
}) as typeof React.createElement
void RealReact

export async function run(mount: Element): Promise<string> {
  const stage = (globalThis as { __hwStage?: string }).__hwStage ?? 'app'
  if (stage === 'smoke') {
    const root = createRoot(mount)
    console.log('smoke:start')
    root.render(React.createElement('section', null, 'plain'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    console.log('smoke:plain', mount.innerHTML.slice(0, 80))
    root.render(<div style={{ display: 'flex' }}><text>hello</text></div>)
    await new Promise((resolve) => setTimeout(resolve, 100))
    console.log('smoke:rendered', mount.innerHTML.slice(0, 200))
    return mount.innerHTML
  }
  const state = createInitialState('/tmp/demo')
  const first = allProjectionSnapshots()[0] as { messages?: unknown[] } | undefined
  Object.assign(state, { messages: first?.messages ?? [], connection: 'connected' })
  const listeners = new Set<() => void>()
  const base = { presence: new PresenceRegistry(), subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }, getSnapshot: () => state, loadEarlierMessages: async () => {} }
  const controller = new Proxy(base, { get(target, key) { return key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined } }) as never
  const root = createRoot(mount)
  await act(async () => {
    root.render(
      <GpuixContext.Provider value={{ renderer: domRenderer }}>
        <WorkbenchApp controller={controller} presenters={new Map()} ui={new WorkbenchUiRegistry()} />
      </GpuixContext.Provider>,
    )
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  return mount.innerHTML
}
