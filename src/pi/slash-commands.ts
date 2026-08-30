import type { RpcSlashCommand, SlashCommand } from './types.ts'

// Pi intentionally omits built-ins from RPC get_commands. Keep this aligned with Pi's core/slash-commands.ts.
const BUILTIN_DEFINITIONS = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model', argumentHint: '<provider/model>' },
  { name: 'tree', description: 'Navigate session tree' },
  { name: 'thinking', description: 'Set thinking level', argumentHint: '<level>' },
  { name: 'scoped-models', description: 'Enable or disable models for cycling' },
  { name: 'export', description: 'Export session as HTML', argumentHint: '[file.html]' },
  { name: 'import', description: 'Import and resume a JSONL session', argumentHint: '<file.jsonl>' },
  { name: 'share', description: 'Share session as a private GitHub gist' },
  { name: 'copy', description: 'Copy last assistant message to clipboard' },
  { name: 'name', description: 'Set session display name', argumentHint: '<name>' },
  { name: 'session', description: 'Show session information and stats' },
  { name: 'changelog', description: 'Show Pi changelog entries' },
  { name: 'hotkeys', description: 'Show Pi keyboard shortcuts' },
  { name: 'fork', description: 'Fork from a previous user message' },
  { name: 'clone', description: 'Duplicate the current session' },
  { name: 'trust', description: 'Save a project trust decision' },
  { name: 'login', description: 'Configure provider authentication', argumentHint: '<provider>' },
  { name: 'logout', description: 'Remove provider authentication' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Compact session context', argumentHint: '[instructions]' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload Pi resources and context' },
  { name: 'quit', description: 'Quit Heddlework' },
] as const

export type BuiltinSlashCommandName = typeof BUILTIN_DEFINITIONS[number]['name']

export interface ParsedBuiltinSlashCommand {
  name: BuiltinSlashCommandName
  argument: string
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = BUILTIN_DEFINITIONS.map((command) => ({
  ...command,
  source: 'builtin' as const,
}))

const BUILTIN_NAMES = new Set<string>(BUILTIN_DEFINITIONS.map((command) => command.name))
const INTERNAL_COMMAND_NAMES = new Set(['heddlework-tree-navigate'])

export function parseBuiltinSlashCommand(text: string): ParsedBuiltinSlashCommand | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match || !BUILTIN_NAMES.has(match[1]!)) return undefined
  return {
    name: match[1] as BuiltinSlashCommandName,
    argument: match[2]?.trim() ?? '',
  }
}

export function slashCommandsFromRpc(value: unknown): SlashCommand[] {
  const commands = value && typeof value === 'object' && Array.isArray((value as { commands?: unknown }).commands)
    ? (value as { commands: unknown[] }).commands
    : []
  const seen = new Set(BUILTIN_NAMES)
  const discovered: RpcSlashCommand[] = []
  for (const command of commands) {
    if (!command || typeof command !== 'object') continue
    const candidate = command as Record<string, unknown>
    if (
      typeof candidate.name !== 'string'
      || (candidate.source !== 'extension' && candidate.source !== 'prompt' && candidate.source !== 'skill')
      || seen.has(candidate.name)
      || INTERNAL_COMMAND_NAMES.has(candidate.name)
    ) continue
    seen.add(candidate.name)
    discovered.push({
      name: candidate.name,
      source: candidate.source,
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
      ...(typeof candidate.argumentHint === 'string' ? { argumentHint: candidate.argumentHint } : {}),
      ...(candidate.sourceInfo && typeof candidate.sourceInfo === 'object' ? { sourceInfo: candidate.sourceInfo as Record<string, unknown> } : {}),
    })
  }
  return [...BUILTIN_SLASH_COMMANDS, ...discovered]
}
