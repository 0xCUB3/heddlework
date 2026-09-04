export type ReceiptFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface ReceiptFile {
  path: string
  status: ReceiptFileStatus
  additions: number
  deletions: number
  patch?: string | undefined
  truncated?: boolean | undefined
}

export interface ReceiptToolCount {
  name: string
  count: number
}

export interface MutationReceipt {
  id: string
  sessionPath: string
  turn: number
  startedAt: number
  completedAt: number
  files: ReceiptFile[]
  tools: ReceiptToolCount[]
  commit?: string | undefined
}

export const RECEIPT_PATCH_LIMIT_BYTES = 200 * 1024
export const RECEIPTS_PER_SESSION = 200
