import { describe, expect, it } from 'bun:test'
import {
  buildAskUserDialogActions,
  dialogMatchesAskUserAction,
  questionnaireFromTool,
  type AskUserQuestionnaire,
} from '../src/workbench/ask-user.ts'
import type { ExtensionDialog, ToolRun } from '../src/workbench/state.ts'
import { filterExtensionOptions, parseExtensionOption, parseExtensionTitle, plainExtensionText } from '../src/ui/extension-ui.ts'

const questionnaire: AskUserQuestionnaire = {
  toolCallId: 'ask-1',
  questions: [
    {
      question: 'Which runtime?',
      header: 'Runtime',
      multiSelect: false,
      options: [
        { label: 'Bun', description: 'Fast', preview: '# Bun' },
        { label: 'Node', description: 'Compatible' },
      ],
    },
    {
      question: 'Which checks?',
      header: 'Checks',
      multiSelect: true,
      options: [
        { label: 'Types', description: 'Typecheck' },
        { label: 'Tests', description: 'Test suite' },
      ],
    },
  ],
}

describe('ask-user host adapter', () => {
  it('parses an active tool without dropping previews', () => {
    const tool: ToolRun = {
      id: 'ask-1',
      name: 'ask_user_question',
      args: { questions: questionnaire.questions },
      status: 'running',
      isError: false,
    }
    expect(questionnaireFromTool(tool)).toEqual(questionnaire)
    expect(questionnaireFromTool({ ...tool, status: 'complete' })).toBeUndefined()
  })

  it('plans option, custom follow-up, multi-select, and empty multi responses', () => {
    expect(buildAskUserDialogActions(questionnaire, [
      { kind: 'custom', value: 'Deno' },
      { kind: 'multi', optionIndices: [1, 0, 1] },
    ])).toEqual([
      { method: 'select', questionIndex: 0, question: 'Which runtime?', optionIndex: 2 },
      { method: 'input', questionIndex: 0, question: 'Which runtime?', value: 'Deno' },
      { method: 'input', questionIndex: 1, question: 'Which checks?', value: '1,2' },
    ])

    expect(buildAskUserDialogActions(questionnaire, [
      { kind: 'option', optionIndex: 0 },
      { kind: 'multi', optionIndices: [] },
    ]).at(-1)?.value).toBe('')
  })

  it('rejects incomplete or incompatible answers', () => {
    expect(() => buildAskUserDialogActions(questionnaire, [])).toThrow('Answer every question')
    expect(() => buildAskUserDialogActions(questionnaire, [
      { kind: 'multi', optionIndices: [] },
      { kind: 'multi', optionIndices: [] },
    ])).toThrow('requires one choice')
  })

  it('correlates fallback requests by method and authored question', () => {
    const dialog: ExtensionDialog = { id: 'd', method: 'select', title: '[Runtime] Which runtime?', options: [], createdAt: 1 }
    expect(dialogMatchesAskUserAction(dialog, { method: 'select', questionIndex: 0, question: 'Which runtime?', optionIndex: 0 })).toBe(true)
    expect(dialogMatchesAskUserAction(dialog, { method: 'input', questionIndex: 0, question: 'Which runtime?', value: 'Deno' })).toBe(false)
  })
})

describe('extension UI text projection', () => {
  it('strips ANSI and control bytes', () => {
    expect(plainExtensionText('\u001b[31m$12.00\u001b[0m\u0007')).toBe('$12.00')
  })

  it('parses Fabric and numbered questionnaire rows while retaining wire values', () => {
    const fabric = parseExtensionOption('Executor · quickjs — Runtime and resource limits.')
    expect(fabric).toEqual({
      value: 'Executor · quickjs — Runtime and resource limits.',
      label: 'Executor',
      detail: 'quickjs · Runtime and resource limits.',
    })
    expect(parseExtensionOption('2. Node — Compatible')).toEqual({
      value: '2. Node — Compatible',
      label: 'Node',
      detail: 'Compatible',
      ordinal: '2',
    })
  })

  it('splits breadcrumb details and searches labels plus descriptions', () => {
    expect(parseExtensionTitle('Fabric settings › Agents\nOne-shot child agents.')).toEqual({ title: 'Fabric settings › Agents', detail: 'One-shot child agents.' })
    const options = ['Executor — Runtime limits', 'Agents — Child models'].map(parseExtensionOption)
    expect(filterExtensionOptions(options, 'child').map((option) => option.label)).toEqual(['Agents'])
  })
})
