import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { FlowRuntime, type FlowRuntimeOptions } from './runtime.ts'

export const flowRuntimeToken = serviceToken<FlowRuntime>('flow-runtime')

export function createFlowRuntimePlugin(options: FlowRuntimeOptions = {}): WorkbenchPlugin {
  return {
    id: 'flow-runtime',
    requires: [workbenchControllerToken],
    activate(ctx) {
      const runtime = new FlowRuntime(ctx.get(workbenchControllerToken), options)
      ctx.provide(flowRuntimeToken, runtime)
      runtime.start()
      ctx.effect(() => () => runtime.dispose())
    },
  }
}
