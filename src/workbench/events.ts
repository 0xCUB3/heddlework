import type { TransportStatus } from '../pi/transport.ts'
import type { RpcRecord } from '../pi/types.ts'

declare module '../core/kernel.ts' {
  interface WorkbenchEvents {
    /** @mode emit */
    'agent/event'(event: RpcRecord): void
    /** @mode emit */
    'agent/status'(status: TransportStatus): void
  }
}

export {}
