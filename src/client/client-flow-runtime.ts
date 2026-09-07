import type { FlowRuntimeSnapshot, FlowSchedule, FlowScheduleInput, FlowTemplate, FlowLaunch } from '../flows/types.ts'
import type { WorkspaceClient } from '../web/client.ts'
import type { FlowRuntimeSurface } from '../flows/runtime.ts'

/** Flow runtime mirror for attach clients: snapshot from the host WebSocket, mutations via protocol commands. */
export class ClientFlowRuntime implements FlowRuntimeSurface {
  readonly #client: WorkspaceClient
  readonly #listeners = new Set<() => void>()
  #unsubscribe: () => void

  constructor(client: WorkspaceClient) {
    this.#client = client
    this.#unsubscribe = client.subscribe(() => {
      for (const listener of this.#listeners) listener()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  getSnapshot = (): FlowRuntimeSnapshot => {
    return this.#client.getSnapshot().flows ?? emptyFlowSnapshot()
  }

  start(): void {}

  dispose(): void {
    this.#unsubscribe()
    this.#listeners.clear()
  }

  async mergeLane(laneId: string): Promise<{ merged: true } | { merged: false; message: string }> {
    await this.#client.send({ type: 'mergeLane', laneId })
    return { merged: true }
  }

  async removeLane(laneId: string): Promise<void> {
    await this.#client.send({ type: 'removeLane', laneId })
  }

  createSchedule(_input: FlowScheduleInput): FlowSchedule {
    throw new Error('Flow schedule editing is not exposed on attach clients yet')
  }

  setScheduleEnabled(_id: string, _enabled: boolean): void {
    throw new Error('Flow schedule editing is not exposed on attach clients yet')
  }

  removeSchedule(_id: string): void {
    throw new Error('Flow schedule editing is not exposed on attach clients yet')
  }

  launch(_template: FlowTemplate): FlowLaunch {
    throw new Error('Flow launches are not exposed on attach clients yet')
  }

  runScheduleNow(_id: string): FlowLaunch | undefined {
    throw new Error('Flow schedule runs are not exposed on attach clients yet')
  }
}

function emptyFlowSnapshot(): FlowRuntimeSnapshot {
  return { schedules: [], runs: [], pending: [] }
}


