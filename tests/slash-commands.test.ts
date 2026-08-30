import { describe, expect, it } from 'bun:test'
import { BUILTIN_SLASH_COMMANDS, parseBuiltinSlashCommand, slashCommandsFromRpc } from '../src/pi/slash-commands.ts'

const BUILTIN_NAMES = [
  'settings',
  'model',
  'tree',
  'thinking',
  'scoped-models',
  'export',
  'import',
  'share',
  'copy',
  'name',
  'session',
  'changelog',
  'hotkeys',
  'fork',
  'clone',
  'trust',
  'login',
  'logout',
  'new',
  'compact',
  'resume',
  'reload',
  'quit',
]

describe('Pi slash commands', () => {
  it('catalogs every built-in interactive command and parses only exact built-in names', () => {
    expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toEqual(BUILTIN_NAMES)
    expect(parseBuiltinSlashCommand('/compact focus on decisions')).toEqual({ name: 'compact', argument: 'focus on decisions' })
    expect(parseBuiltinSlashCommand('  /name Release audit  ')).toEqual({ name: 'name', argument: 'Release audit' })
    expect(parseBuiltinSlashCommand('/compactness')).toBeUndefined()
    expect(parseBuiltinSlashCommand('/fabric settings')).toBeUndefined()
  })

  it('merges RPC commands after built-ins while preserving built-in precedence', () => {
    const commands = slashCommandsFromRpc({ commands: [
      { name: 'compact', description: 'Conflicting extension', source: 'extension', sourceInfo: {} },
      { name: 'fabric', description: 'Fabric controls', source: 'extension', sourceInfo: { path: '/tmp/fabric.ts' } },
      { name: 'review', description: 'Review changes', argumentHint: '[focus]', source: 'prompt' },
      { name: 'skill:search', source: 'skill' },
      { name: 'heddlework-tree-navigate', description: 'Internal bridge', source: 'extension', sourceInfo: {} },
      { name: 42, source: 'extension' },
    ] })

    expect(commands.filter((command) => command.name === 'compact')).toEqual([
      expect.objectContaining({ name: 'compact', source: 'builtin' }),
    ])
    expect(commands.some((command) => command.name === 'heddlework-tree-navigate')).toBe(false)
    expect(commands.slice(-3)).toEqual([
      { name: 'fabric', description: 'Fabric controls', source: 'extension', sourceInfo: { path: '/tmp/fabric.ts' } },
      { name: 'review', description: 'Review changes', argumentHint: '[focus]', source: 'prompt' },
      { name: 'skill:search', source: 'skill' },
    ])
  })
})
