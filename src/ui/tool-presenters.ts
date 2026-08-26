import { slotToken, type WorkbenchPlugin } from '../core/kernel.ts'
import type { ToolRun } from '../workbench/state.ts'

export interface ToolPresentation {
  title?: string | undefined
  kind: 'code' | 'diff' | 'text'
  content: string
  language?: string | undefined
  path?: string | undefined
}

export interface ToolPresenter {
  present(tool: ToolRun): ToolPresentation | undefined
}

export const toolPresenterSlot = slotToken<ToolPresenter>('workbench.tool-presenter')

export const coreToolPresentersPlugin: WorkbenchPlugin = {
  id: 'core-tool-presenters',
  activate(ctx) {
    ctx.contribute(toolPresenterSlot, 'bash', {
      present(tool) {
        const command = stringProperty(tool.args, 'command')
        return {
          title: command || undefined,
          kind: 'code',
          content: tool.output ?? '',
          language: 'bash',
        }
      },
    })
    ctx.contribute(toolPresenterSlot, 'read', {
      present(tool) {
        const path = stringProperty(tool.args, 'path')
        return {
          title: path || undefined,
          kind: 'code',
          content: tool.output ?? '',
          path: path || undefined,
        }
      },
    })
    const editPresenter: ToolPresenter = {
      present(tool) {
        const path = stringProperty(tool.args, 'path')
        const diff = findStringProperty(tool.details, 'diff') ?? findDiff(tool.output)
        return diff
          ? { title: path || undefined, kind: 'diff', content: diff }
          : { title: path || undefined, kind: 'code', content: tool.output ?? '', path: path || undefined }
      },
    }
    ctx.contribute(toolPresenterSlot, 'edit', editPresenter)
    ctx.contribute(toolPresenterSlot, 'write', editPresenter)
  },
}

export function resolveToolPresentation(tool: ToolRun, presenters: ReadonlyMap<string, ToolPresenter>): ToolPresentation {
  const exact = presenters.get(tool.name)?.present(tool)
  if (exact) return exact
  const diff = findStringProperty(tool.details, 'diff') ?? findDiff(tool.output)
  if (diff) return { kind: 'diff', content: diff }
  return { kind: 'code', content: tool.output ?? '', language: tool.name === 'grep' ? 'text' : undefined }
}

function stringProperty(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : ''
}

function findStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const direct = (value as Record<string, unknown>)[key]
  if (typeof direct === 'string') return direct
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findStringProperty(child, key)
    if (found) return found
  }
  return undefined
}

function findDiff(value: string | undefined): string | undefined {
  if (!value) return undefined
  const marker = value.indexOf('diff --git ')
  return marker >= 0 ? value.slice(marker) : undefined
}
