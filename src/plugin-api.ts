export { BrowserIntegrationService, createBrowserIntegrationService, createBrowserTaskAdapters, loadCustomBrowserAdapters } from './browser/integrations.ts'
export type { BrowserTaskAdapter, CustomBrowserAdapterConfig } from './browser/integrations.ts'
export type { BrowserIntegrationCommand, BrowserIntegrationSnapshot, BrowserIntegrationChoice, BrowserIntegrationTask } from './browser/integration-types.ts'
export { serviceToken, slotToken } from './core/kernel.ts'
export type {
  Cleanup,
  EventOptions,
  PluginContext,
  ServiceToken,
  SlotToken,
  WorkbenchEvents,
  WorkbenchPlugin,
} from './core/kernel.ts'
export {
  agentTransportToken,
  sessionCatalogToken,
  workspaceDiffToken,
} from './workbench/plugins.ts'
export type { SessionCatalogService, WorkspaceDiffService } from './workbench/services.ts'
export { workbenchUiRegistryToken } from './ui/extensions.ts'
export {
  applyWorkbenchCommand,
  applySnapshotPatch,
  describePiAdapter,
  diffSnapshots,
  isHarnessAdapter,
  isSleepPreventionCommand,
  isWorkbenchCommand,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  serializeSnapshot,
  SLEEP_PREVENTION_COMMAND_TYPES,
  WORKBENCH_COMMAND_TYPES,
} from './protocol/index.ts'
export type {
  ClientMessage,
  HarnessAdapter,
  HarnessCapabilities,
  ServerMessage,
  SleepPreventionCommand,
  SnapshotPatch,
  WorkbenchCommand,
  WorkbenchCommandType,
  WorkbenchSnapshot,
} from './protocol/index.ts'
export { terminalSessionToken, createTerminalPlugin } from './terminal/plugin.ts'
export { TerminalSessionService } from './terminal/service.ts'
export { DEFAULT_TERMINAL_APPEARANCE, terminalAppearancePreferencePath } from './terminal/appearance.ts'
export { BunPtyBackend, MemoryTerminalBackend, bunTerminalAvailable } from './terminal/backend.ts'
export type { TerminalBackend, TerminalOutputMetadata, TerminalProcess } from './terminal/backend.ts'
export type {
  TerminalAppearance,
  TerminalGridSnapshot,
  TerminalPlacement,
  TerminalServiceSnapshot,
  TerminalSessionId,
  TerminalSessionInfo,
  TerminalSpawnRequest,
} from './terminal/types.ts'
export { createSleepPreventionPlugin, sleepPreventionToken } from './power/plugin.ts'
export { SleepPreventionService } from './power/service.ts'
export { parseSleepPreventionPolicy, DEFAULT_SLEEP_PREVENTION_POLICY } from './power/types.ts'
export type { SleepPreventionPolicy, SleepPreventionSnapshot, SleepPreventionWhen, SleepPreventionStatus } from './power/types.ts'
export { hostWorkIsRunning, shouldInhibitSleep } from './power/activity.ts'
export { createFlowRuntimePlugin, flowRuntimeToken } from './flows/plugin.ts'
export type { FlowRuntime, FlowRuntimeHost, FlowRuntimeOptions } from './flows/runtime.ts'
export type { FlowLaunch, FlowMode, FlowRuntimeSnapshot, FlowSchedule, FlowScheduleInput, FlowScheduleTiming, FlowTemplate } from './flows/types.ts'
export type {
  RegisteredWorkbenchSurface,
  WorkbenchSurfaceContribution,
  WorkbenchSurfaceProps,
  WorkbenchUiExtension,
  WorkbenchUiSnapshot,
} from './ui/extensions.ts'
export { HEDDLEWORK_PLUGIN_API_VERSION, isCompatible, parsePluginManifest } from './plugins/manifest.ts'
export type { PluginManifest } from './plugins/manifest.ts'
export type { PluginLoadEntry, PluginLoadReport, PluginLoadStatus } from './plugins/loader.ts'
export { createReceiptPlugin, receiptStoreToken } from './receipts/plugin.ts'
export { checkForUpdate } from './updates/check.ts'
export type { UpdateCheckResult } from './updates/check.ts'
export { createUpdateCheckPlugin, createUpdatePlugin, updateServiceToken } from './updates/plugin.ts'
export { UpdateService, type UpdateState, type UpdateStatus } from './updates/service.ts'
export type { UpdateChannel } from './updates/feed.ts'
export { checkoutLaneToken, createCheckoutLanePlugin, GitCheckoutLanes, laneBranch } from './workspace/checkout-lanes.ts'
export type { CheckoutLane, CheckoutLaneService } from './workspace/checkout-lanes.ts'
export { readyTasks, topologicalOrder } from './flows/graph.ts'
export { validateFlowGraph } from './flows/types.ts'
export type { FlowLaneKind, FlowRunRecord, FlowTaskRecord, FlowTaskSpec } from './flows/types.ts'
export { FileReceiptStore, receiptStorePath } from './receipts/store.ts'
export type { ReceiptStoreService } from './receipts/store.ts'
export type { MutationReceipt, ReceiptFile, ReceiptFileStatus, ReceiptToolCount } from './receipts/types.ts'
export { pluginReportToken } from './plugins/host.ts'
export type { PluginHost } from './plugins/host.ts'
