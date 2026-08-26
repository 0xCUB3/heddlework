import type { RpcCommand, RpcRecord } from './types.ts'

export type TransportStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; pid?: number }
  | { state: 'exited'; message: string }

export interface AgentTransport {
  start(): Promise<void>
  stop(): Promise<void>
  request<T = unknown>(command: RpcCommand): Promise<T>
  send(record: RpcRecord): void
  onEvent(listener: (event: RpcRecord) => void): () => void
  onStatus(listener: (status: TransportStatus) => void): () => void
  getStderr(): string
}
