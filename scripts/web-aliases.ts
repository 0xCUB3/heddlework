// Bun.build plugin that swaps the gpuix runtime and node-bound desktop modules for browser implementations.

import { resolve } from 'node:path'
import type { BunPlugin } from 'bun'

export function webAliasPlugin(root: string): BunPlugin {
  const dom = (file: string) => resolve(root, 'src/dom', file)
  const exact: Record<string, string> = {
    '@gpuix/react': dom('host.tsx'),
    '@gpuix/react/jsx-runtime': dom('host.tsx'),
    '@gpuix/react/jsx-dev-runtime': dom('host.tsx'),
    'node:path': dom('shims/node-path.ts'),
    'path': dom('shims/node-path.ts'),
  }
  // Desktop modules whose exports the browser replaces one for one.
  const files: Record<string, string> = {
    'src/ui/clipboard-media.ts': dom('shims/clipboard-media.ts'),
    'src/ui/open-external.ts': dom('shims/open-external.ts'),
    'src/ui/theme-manager.ts': dom('shims/theme-manager.ts'),
    'src/ui/phone-pairing.tsx': dom('shims/phone-pairing.tsx'),
    'src/host/server.ts': dom('shims/host-server.ts'),
    'src/pi/rpc-transport.ts': dom('shims/rpc-transport.ts'),
    'src/pi/session-history.ts': dom('shims/session-history.ts'),
  }
  const byAbsolute = new Map(Object.entries(files).map(([relative, target]) => [resolve(root, relative), target]))
  return {
    name: 'heddlework-web-aliases',
    setup(build) {
      build.onResolve({ filter: /^(@gpuix\/react(\/jsx(-dev)?-runtime)?|node:path|path)$/u }, (args) => ({ path: exact[args.path]! }))
      build.onResolve({ filter: /^@gpuix\/react\/(select|combobox|tooltip)$/u }, (args) => ({ path: resolve(root, 'node_modules/@gpuix/react/dist/components', `${args.path.slice('@gpuix/react/'.length)}.js`) }))
      // Only application code sees the patched React; react-dom and the shim itself keep the real package.
      build.onResolve({ filter: /^react$/u }, (args) => {
        if (args.importer.includes('/node_modules/') || args.importer.startsWith(resolve(root, 'src/dom'))) return undefined
        return { path: dom('react-shim.ts') }
      })
      build.onResolve({ filter: /\.(ts|tsx)$/u }, (args) => {
        if (args.path.startsWith('@gpuix/')) return undefined
        if (args.importer.startsWith(resolve(root, 'src/dom/shims'))) return undefined
        const absolute = args.path.startsWith('.') ? resolve(args.importer, '..', args.path) : args.path
        const target = byAbsolute.get(absolute)
        return target ? { path: target } : undefined
      })
    },
  }
}
