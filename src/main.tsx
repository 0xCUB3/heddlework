import React from 'react'
import { render } from '@gpuix/react'
import { resolve } from 'node:path'
import { WorkbenchKernel } from './core/kernel.ts'
import { WorkbenchApp } from './ui/app.tsx'
import { coreToolPresentersPlugin, toolPresenterSlot } from './ui/tool-presenters.ts'
import {
  createAgentTransportPlugin,
  createWorkbenchControllerPlugin,
  workbenchControllerToken,
} from './workbench/plugins.ts'

interface RuntimeHandle {
  kernel: WorkbenchKernel
  dispose(): Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __piWorkbenchRuntime: RuntimeHandle | undefined
}

const workspacePath = resolveWorkspacePath()
const previous = globalThis.__piWorkbenchRuntime
if (previous) await previous.dispose()

const kernel = new WorkbenchKernel()
kernel.mount(coreToolPresentersPlugin)
kernel.mount(createAgentTransportPlugin({
  cwd: workspacePath,
  demo: process.env.PI_WORKBENCH_DEMO === '1',
  ...(process.env.PI_WORKBENCH_PI ? { command: process.env.PI_WORKBENCH_PI } : {}),
  piArgs: piArgumentsFromEnvironment(),
}))
kernel.mount(createWorkbenchControllerPlugin(workspacePath))

const controller = kernel.get(workbenchControllerToken)
const runtime: RuntimeHandle = {
  kernel,
  dispose: async () => kernel.dispose(),
}
globalThis.__piWorkbenchRuntime = runtime

render(
  <WorkbenchApp controller={controller} presenters={kernel.contributions(toolPresenterSlot)} />,
  {
    title: 'π Workbench',
    width: 1240,
    height: 820,
    titlebarTransparent: true,
    windowBackground: process.platform === 'darwin' ? 'blurred' : 'opaque',
    trafficLightX: 16,
    trafficLightY: 17,
    debugFrameOverlay: debugOverlay(),
  },
)

void controller.start()

const shutdown = () => {
  void runtime.dispose().finally(() => process.exit(0))
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

function resolveWorkspacePath(): string {
  if (process.env.PI_WORKBENCH_CWD) return resolve(process.env.PI_WORKBENCH_CWD)
  const argument = process.argv.slice(2).find((value) => value !== '--' && !value.startsWith('-'))
  return resolve(argument ?? process.cwd())
}

function piArgumentsFromEnvironment(): string[] {
  const args: string[] = []
  if (process.env.PI_WORKBENCH_PROVIDER) args.push('--provider', process.env.PI_WORKBENCH_PROVIDER)
  if (process.env.PI_WORKBENCH_MODEL) args.push('--model', process.env.PI_WORKBENCH_MODEL)
  if (process.env.PI_WORKBENCH_NO_SESSION === '1') args.push('--no-session')
  return args
}

function debugOverlay(): 'hidden' | 'minimal' | 'full' {
  const value = process.env.PI_WORKBENCH_DEBUG_OVERLAY
  return value === 'minimal' || value === 'full' ? value : 'hidden'
}
