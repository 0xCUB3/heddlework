export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface PiModel {
  id: string
  provider: string
  name?: string
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  [key: string]: unknown
}

export interface PiSessionState {
  model: PiModel | null
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  isCompacting?: boolean
  steeringMode?: 'all' | 'one-at-a-time'
  followUpMode?: 'all' | 'one-at-a-time'
  sessionFile?: string
  sessionId?: string
  sessionName?: string
  [key: string]: unknown
}

export interface PiSessionStats {
  sessionFile?: string
  sessionId?: string
  userMessages?: number
  assistantMessages?: number
  toolCalls?: number
  toolResults?: number
  totalMessages?: number
  cost?: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
  [key: string]: unknown
}

export interface PiImageContent {
  type: 'image'
  data: string
  mimeType: string
  previewPath?: string
  [key: string]: unknown
}

export interface ComposerImage extends PiImageContent {
  id: string
  fileName: string
  size: number
}

export interface PiForkMessage {
  entryId: string
  text: string
}

export interface PiContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
  data?: string
  mimeType?: string
  [key: string]: unknown
}

export interface PiMessage {
  role: string
  content?: string | PiContentBlock[]
  customType?: string
  display?: boolean
  timestamp?: number
  toolCallId?: string
  toolName?: string
  isError?: boolean
  command?: string
  output?: string
  exitCode?: number | null
  [key: string]: unknown
}

export type RpcSlashCommandSource = 'extension' | 'prompt' | 'skill'
export type SlashCommandSource = 'builtin' | RpcSlashCommandSource

export interface SlashCommand {
  name: string
  description?: string
  argumentHint?: string
  source: SlashCommandSource
  sourceInfo?: Record<string, unknown>
}

export interface RpcSlashCommand {
  name: string
  description?: string
  argumentHint?: string
  source: RpcSlashCommandSource
  sourceInfo?: Record<string, unknown>
}

export interface RpcCommand {
  type: string
  [key: string]: unknown
}

export interface RpcRecord {
  type: string
  id?: string
  command?: string
  success?: boolean
  error?: string
  data?: unknown
  [key: string]: unknown
}

export type ExtensionUiMethod =
  | 'select'
  | 'confirm'
  | 'input'
  | 'editor'
  | 'notify'
  | 'setStatus'
  | 'setWidget'
  | 'setTitle'
  | 'set_editor_text'

export interface ExtensionUiRequest extends RpcRecord {
  type: 'extension_ui_request'
  id: string
  method: ExtensionUiMethod
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
  notifyType?: 'info' | 'warning' | 'error'
  statusKey?: string
  statusText?: string
  widgetKey?: string
  widgetLines?: string[]
  widgetPlacement?: 'aboveEditor' | 'belowEditor'
  text?: string
}

export function isExtensionUiRequest(record: RpcRecord): record is ExtensionUiRequest {
  return record.type === 'extension_ui_request' && typeof record.id === 'string' && typeof record.method === 'string'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
