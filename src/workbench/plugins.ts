import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { DemoTransport } from '../pi/demo-transport.ts'
import { PiRpcTransport, type PiRpcTransportOptions } from '../pi/rpc-transport.ts'
import type { AgentTransport } from '../pi/transport.ts'
import { WorkbenchController } from './controller.ts'

export const agentTransportToken = serviceToken<AgentTransport>('agent-transport')
export const workbenchControllerToken = serviceToken<WorkbenchController>('workbench-controller')

export function createAgentTransportPlugin(options: PiRpcTransportOptions & { demo: boolean }): WorkbenchPlugin {
  return {
    id: options.demo ? 'demo-agent-transport' : 'pi-rpc-agent-transport',
    activate(ctx) {
      const transport: AgentTransport = options.demo ? new DemoTransport() : new PiRpcTransport(options)
      ctx.provide(agentTransportToken, transport)
      ctx.effect(() => async () => transport.stop())
    },
  }
}

export function createWorkbenchControllerPlugin(workspacePath: string): WorkbenchPlugin {
  return {
    id: 'workbench-controller',
    requires: [agentTransportToken],
    activate(ctx) {
      const controller = new WorkbenchController(ctx.get(agentTransportToken), workspacePath)
      ctx.provide(workbenchControllerToken, controller)
      ctx.effect(() => async () => controller.dispose())
    },
  }
}
