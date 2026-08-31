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
export { terminalSessionToken, createTerminalPlugin } from './terminal/plugin.ts'
export { TerminalSessionService } from './terminal/service.ts'
export { DEFAULT_TERMINAL_APPEARANCE, terminalAppearancePreferencePath } from './terminal/appearance.ts'
export { BunPtyBackend, MemoryTerminalBackend, bunTerminalAvailable } from './terminal/backend.ts'
export type { TerminalBackend, TerminalProcess } from './terminal/backend.ts'
export type {
  TerminalAppearance,
  TerminalGridSnapshot,
  TerminalPlacement,
  TerminalServiceSnapshot,
  TerminalSessionId,
  TerminalSessionInfo,
  TerminalSpawnRequest,
} from './terminal/types.ts'
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
