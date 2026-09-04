import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { workbenchControllerToken, workspaceDiffToken } from '../workbench/plugins.ts'
import { createReceiptRecorder } from './recorder.ts'
import { FileReceiptStore, type ReceiptStoreService } from './store.ts'

export const receiptStoreToken = serviceToken<ReceiptStoreService>('receipt-store')

export function createReceiptPlugin(options: { path: string | false; store?: ReceiptStoreService | undefined } = { path: false }): WorkbenchPlugin {
  return {
    id: 'receipts',
    requires: [workbenchControllerToken, workspaceDiffToken],
    activate(ctx) {
      const store = options.store ?? new FileReceiptStore(options.path)
      ctx.provide(receiptStoreToken, store)
      const controller = ctx.get(workbenchControllerToken)
      ctx.effect(() => createReceiptRecorder({ controller, workspaceDiff: ctx.get(workspaceDiffToken), store }))
    },
  }
}
