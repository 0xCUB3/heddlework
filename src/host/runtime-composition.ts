import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { WorkbenchKernel } from '../core/kernel.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../flows/plugin.ts'
import { PiSessionCatalog, sessionSidebarCachePath } from '../pi/session-catalog.ts'
import { createReceiptPlugin } from '../receipts/plugin.ts'
import { FileReceiptStore, receiptStorePath } from '../receipts/store.ts'
import { coreToolPresentersPlugin } from '../ui/tool-presenters.ts'
import { createAgentTransportPlugin, createSessionCatalogPlugin, createWorkbenchControllerPlugin, localWorkspaceDiffPlugin, workbenchControllerToken } from '../workbench/plugins.ts'
import { FileQueueStore } from '../workbench/queue-store.ts'
import { FileThreadMetadataStore, threadMetadataStorePath } from '../workbench/thread-metadata-store.ts'
import { FileThreadTitleSettingsStore, threadTitleSettingsPath } from '../workbench/thread-title-settings-store.ts'
import { createPiTitleGenerator } from './title-generator.ts'
import { createCheckoutLanePlugin } from '../workspace/checkout-lanes.ts'
import { startExternalPlugins } from '../plugins/host.ts'

export interface SessionFactoryInput { workspacePath: string; sessionPath?: string | undefined; id: string }

export function createRuntimeSessionFactory(directory: string, demo = false) {
  const isolated = demo || process.env.HEDDLEWORK_RUNTIME_TEST === '1'
  const receipts = new FileReceiptStore(isolated ? false : receiptStorePath())
  const metadata = new FileThreadMetadataStore(isolated ? false : threadMetadataStorePath())
  const titleSettings = new FileThreadTitleSettingsStore(isolated ? false : threadTitleSettingsPath())
  const sessionCatalog = new PiSessionCatalog({ cachePath: isolated ? false : sessionSidebarCachePath() })
  // Demo sessions have no real model behind them, so titles stay off there.
  const titleGenerator = demo ? undefined : createPiTitleGenerator({ ...(process.env.HEDDLEWORK_PI ? { command: process.env.HEDDLEWORK_PI } : {}) })
  return async ({ workspacePath, sessionPath, id }: SessionFactoryInput) => {
    const storageKey = createHash('sha256').update(sessionPath ?? id).digest('hex').slice(0, 24)
    const stateDirectory = join(directory, 'sessions', storageKey)
    const kernel = new WorkbenchKernel()
    kernel.mount(coreToolPresentersPlugin)
    kernel.mount(createWorkbenchControllerPlugin(workspacePath, { queueStore: new FileQueueStore(join(stateDirectory, 'queue.json')), threadMetadataStore: metadata, titleGenerator, titleSettingsStore: titleSettings }))
    kernel.mount(createCheckoutLanePlugin())
    kernel.mount(createFlowRuntimePlugin({ path: join(stateDirectory, 'flows.json'), lanesFromKernel: true }))
    kernel.mount(createSessionCatalogPlugin({}, sessionCatalog))
    kernel.mount(localWorkspaceDiffPlugin)
    kernel.mount(createReceiptPlugin({ path: false, store: receipts }))
    const piArgs: string[] = []
    if (process.env.HEDDLEWORK_PROVIDER) piArgs.push('--provider', process.env.HEDDLEWORK_PROVIDER)
    if (process.env.HEDDLEWORK_MODEL) piArgs.push('--model', process.env.HEDDLEWORK_MODEL)
    if (sessionPath) piArgs.push('--session', sessionPath)
    else if (process.env.HEDDLEWORK_NO_SESSION === '1') piArgs.push('--no-session')
    kernel.mount(createAgentTransportPlugin({ cwd: workspacePath, demo, ...(process.env.HEDDLEWORK_PI ? { command: process.env.HEDDLEWORK_PI } : {}), piArgs }))
    const plugins = await startExternalPlugins(kernel, workspacePath, { trustPath: isolated ? false : undefined })
    const controller = kernel.get(workbenchControllerToken)
    const flows = kernel.get(flowRuntimeToken)
    return { controller, flows, plugins, kernel, dispose: () => kernel.dispose() }
  }
}
