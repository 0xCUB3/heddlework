import type { FlowMode, FlowScheduleInput, FlowScheduleTiming, FlowTaskSpec, FlowTemplate } from '../flows/types.ts'

export type FlowWorkbenchCommand =
  | { type: 'createFlowSchedule'; input: FlowScheduleInput }
  | { type: 'setFlowScheduleEnabled'; id: string; enabled: boolean }
  | { type: 'removeFlowSchedule'; id: string }
  | { type: 'launchFlow'; template: FlowTemplate }
  | { type: 'runFlowScheduleNow'; id: string }

export const FLOW_WORKBENCH_COMMAND_TYPES = [
  'createFlowSchedule',
  'setFlowScheduleEnabled',
  'removeFlowSchedule',
  'launchFlow',
  'runFlowScheduleNow',
] as const

function isFlowMode(value: unknown): value is FlowMode {
  return value === 'sequential' || value === 'parallel'
}

function isFlowScheduleTiming(value: unknown): value is FlowScheduleTiming {
  if (!value || typeof value !== 'object') return false
  const timing = value as { kind?: unknown }
  if (timing.kind === 'once') return typeof (timing as { at?: unknown }).at === 'number'
  if (timing.kind === 'interval') {
    const interval = timing as { everyMinutes?: unknown; anchorAt?: unknown }
    return typeof interval.everyMinutes === 'number' && typeof interval.anchorAt === 'number'
  }
  if (timing.kind === 'daily') {
    const daily = timing as { hour?: unknown; minute?: unknown }
    return typeof daily.hour === 'number' && typeof daily.minute === 'number'
  }
  return false
}

function isFlowTaskSpec(value: unknown): value is FlowTaskSpec {
  if (!value || typeof value !== 'object') return false
  const task = value as { id?: unknown; prompt?: unknown }
  return typeof task.id === 'string' && typeof task.prompt === 'string'
}

function isFlowTemplate(value: unknown): value is FlowTemplate {
  if (!value || typeof value !== 'object') return false
  const template = value as { title?: unknown; prompts?: unknown; mode?: unknown; workspacePath?: unknown; tasks?: unknown }
  if (typeof template.title !== 'string' || !Array.isArray(template.prompts) || !isFlowMode(template.mode)) return false
  if (typeof template.workspacePath !== 'string') return false
  if (!template.prompts.every((prompt) => typeof prompt === 'string')) return false
  if (template.tasks !== undefined && (!Array.isArray(template.tasks) || !template.tasks.every(isFlowTaskSpec))) return false
  return true
}

export function isFlowScheduleInput(value: unknown): value is FlowScheduleInput {
  if (!isFlowTemplate(value)) return false
  const input = value as FlowScheduleInput & { timing?: unknown; enabled?: unknown }
  if (!isFlowScheduleTiming(input.timing)) return false
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return false
  return true
}

export function isFlowWorkbenchCommand(value: unknown): value is FlowWorkbenchCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as { type?: unknown }
  switch (command.type) {
    case 'createFlowSchedule':
      return isFlowScheduleInput((command as { input?: unknown }).input)
    case 'setFlowScheduleEnabled': {
      const entry = command as { id?: unknown; enabled?: unknown }
      return typeof entry.id === 'string' && typeof entry.enabled === 'boolean'
    }
    case 'removeFlowSchedule':
      return typeof (command as { id?: unknown }).id === 'string'
    case 'launchFlow':
      return isFlowTemplate((command as { template?: unknown }).template)
    case 'runFlowScheduleNow':
      return typeof (command as { id?: unknown }).id === 'string'
    default:
      return false
  }
}

