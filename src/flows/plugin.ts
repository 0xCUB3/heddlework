import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { checkoutLaneToken } from '../workspace/checkout-lanes.ts'
import { FlowRuntime, type FlowRuntimeOptions } from './runtime.ts'

export const flowRuntimeToken = serviceToken<FlowRuntime>('flow-runtime')

export function createFlowRuntimePlugin(options: FlowRuntimeOptions & { lanesFromKernel?: boolean | undefined } = {}): WorkbenchPlugin {
  return {
    id: 'flow-runtime',
    requires: options.lanesFromKernel ? [workbenchControllerToken, checkoutLaneToken] : [workbenchControllerToken],
    activate(ctx) {
      const lanes = options.lanes ?? (options.lanesFromKernel ? ctx.get(checkoutLaneToken) : undefined)
      const runtime = new FlowRuntime(ctx.get(workbenchControllerToken), { ...options, lanes })
      ctx.provide(flowRuntimeToken, runtime)
      runtime.start()
      ctx.effect(() => () => runtime.dispose())
    },
  }
}
