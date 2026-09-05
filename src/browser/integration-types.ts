// Browser-safe wire contract. Executable paths and credentials never appear here.
export interface BrowserIntegrationChoice {
  id: string
  label: string
  available: boolean
  description: string
}
export interface BrowserIntegrationTask {
  id: string
  integrationId: string
  profile: string
  prompt: string
  status: 'review' | 'running' | 'completed' | 'failed' | 'cancelled' | 'detached'
  output: string
  expiresAt: number
}
export interface BrowserIntegrationSnapshot {
  choices: BrowserIntegrationChoice[]
  selectedId: string
  profile: string
  task: BrowserIntegrationTask | null
  error: string | null
}
export type BrowserIntegrationCommand =
  | { type: 'selectBrowserIntegration'; integrationId: string; profile: string }
  | { type: 'requestBrowserTask'; prompt: string }
  | { type: 'approveBrowserTask'; id: string }
  | { type: 'cancelBrowserTask'; id: string }
  | { type: 'clearBrowserTask' }

export const BROWSER_INTEGRATION_COMMAND_TYPES = ['selectBrowserIntegration', 'requestBrowserTask', 'approveBrowserTask', 'cancelBrowserTask', 'clearBrowserTask'] as const

export function isBrowserIntegrationCommand(value: unknown): value is BrowserIntegrationCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Record<string, unknown>
  const text = (key: string, max: number) => typeof command[key] === 'string' && (command[key] as string).length <= max
  switch (command.type) {
    case 'selectBrowserIntegration': return text('integrationId', 80) && text('profile', 100)
    case 'requestBrowserTask': return text('prompt', 8000) && Boolean((command.prompt as string).trim())
    case 'approveBrowserTask': case 'cancelBrowserTask': return text('id', 80)
    case 'clearBrowserTask': return true
    default: return false
  }
}
