// Bundles a harness that mounts the desktop WorkbenchApp through the DOM host (same Bun.build plugin as the web build)
// and runs it inside happy-dom, so runtime exceptions and row counts are visible without a browser.
// Run: bun scripts/validation/dom-host-render.tsx

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { Window } from 'happy-dom'
import { webAliasPlugin } from '../web-aliases.ts'

const root = resolve(import.meta.dir, '../..')
const dir = mkdtempSync(join(tmpdir(), 'hw-dom-probe-'))
const entry = join(root, 'scripts/validation/dom-host-harness.tsx')

const result = await Bun.build({
  entrypoints: [entry],
  outdir: dir,
  target: 'browser',
  format: 'esm',
  sourcemap: 'inline',
  tsconfig: resolve(root, 'src/web/tsconfig.json'),
  define: { 'process.env.NODE_ENV': '"development"', 'process.platform': '"darwin"' },
  plugins: [webAliasPlugin(root)],
  jsx: { runtime: 'automatic', importSource: '@gpuix/react' },
  naming: 'harness.js',
})
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1) }

const win = new Window({ innerWidth: 1280, innerHeight: 820, url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const w = win as unknown as Record<string, unknown>
for (const key of ['document', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'ResizeObserver', 'MutationObserver', 'CSS', 'Notification']) {
  if (g[key] === undefined && w[key] !== undefined) g[key] = w[key]
}
g.window = win
g.getComputedStyle = (el: unknown) => win.getComputedStyle(el as never)
g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0)
g.cancelAnimationFrame = (id: number) => clearTimeout(id)
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
g.innerWidth = 1280
g.innerHeight = 820
g.addEventListener = () => {}
g.removeEventListener = () => {}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const errors: string[] = []
const originalError = console.error
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ').slice(0, 220)); originalError(...args) }

const mount = win.document.createElement('div')
win.document.body.appendChild(mount)
g.__hwMount = mount
g.__hwStage = process.env.HW_STAGE ?? 'app'

console.log('bundled', dir)
const harness = await import(join(dir, 'harness.js')) as { run(mount: unknown): Promise<string> }
console.log('imported')
const html = await harness.run(mount)
console.log('length', html.length)
console.log('rows', (html.match(/gx-virtual-row/g) ?? []).length, 'divs', (html.match(/class="gx-div/g) ?? []).length, 'raw-text-tags', (html.match(/<text[ >]/g) ?? []).length)
console.log('errors', errors.length)
for (const error of errors.slice(0, 6)) console.log(' -', error)
writeFileSync('/tmp/hw-audit/dom-probe.html', html)
await win.happyDOM.close()
process.exit(0)
