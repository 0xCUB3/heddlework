import type { PiMessage } from '../pi/types.ts'
import { asRecord, contentText, type LiveAssistant, type ToolRun } from './state.ts'

export type TimelineItem =
  | { id: string; kind: 'user'; text: string; timestamp?: number | undefined }
  | { id: string; kind: 'assistant'; text: string; streaming?: boolean; timestamp?: number | undefined }
  | { id: string; kind: 'thinking'; text: string; streaming?: boolean; timestamp?: number | undefined }
  | { id: string; kind: 'tool'; tool: ToolRun; timestamp?: number | undefined }
  | { id: string; kind: 'status'; text: string; tone?: 'normal' | 'error'; timestamp?: number | undefined }

export function buildTimeline(messages: PiMessage[], liveAssistant: LiveAssistant | undefined, liveTools: ToolRun[]): TimelineItem[] {
  const items: TimelineItem[] = []
  const toolIndexes = new Map<string, number>()

  messages.forEach((message, messageIndex) => {
    const base = `${message.timestamp ?? messageIndex}-${messageIndex}`
    if (message.role === 'user') {
      items.push({ id: `${base}-user`, kind: 'user', text: messageText(message) || '[Image or attachment]', timestamp: message.timestamp })
      return
    }
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        if (message.content) items.push({ id: `${base}-assistant`, kind: 'assistant', text: message.content, timestamp: message.timestamp })
        return
      }
      for (const [blockIndex, candidate] of (message.content ?? []).entries()) {
        const block = asRecord(candidate)
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          items.push({ id: `${base}-text-${blockIndex}`, kind: 'assistant', text: block.text, timestamp: message.timestamp })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          items.push({ id: `${base}-thinking-${blockIndex}`, kind: 'thinking', text: block.thinking, timestamp: message.timestamp })
        } else if (block.type === 'toolCall') {
          const id = String(block.id ?? `${base}-tool-${blockIndex}`)
          const tool: ToolRun = {
            id,
            name: String(block.name ?? 'tool'),
            args: block.arguments,
            status: 'preparing',
            isError: false,
          }
          toolIndexes.set(id, items.length)
          items.push({ id: `tool-${id}`, kind: 'tool', tool, timestamp: message.timestamp })
        }
      }
      return
    }
    if (message.role === 'toolResult') {
      const id = String(message.toolCallId ?? `${base}-result`)
      const existingIndex = toolIndexes.get(id)
      const result: ToolRun = {
        id,
        name: String(message.toolName ?? 'tool'),
        output: contentText(message.content),
        details: message.details,
        status: 'complete',
        isError: Boolean(message.isError),
      }
      if (existingIndex === undefined) {
        toolIndexes.set(id, items.length)
        items.push({ id: `tool-${id}`, kind: 'tool', tool: result, timestamp: message.timestamp })
      } else {
        const existing = items[existingIndex]
        if (existing?.kind === 'tool') items[existingIndex] = { ...existing, tool: { ...existing.tool, ...result, args: existing.tool.args } }
      }
      return
    }
    if (message.role === 'bashExecution') {
      const id = `${base}-bash`
      items.push({
        id,
        kind: 'tool',
        timestamp: message.timestamp,
        tool: {
          id,
          name: 'bash',
          args: { command: message.command },
          output: String(message.output ?? ''),
          status: 'complete',
          isError: typeof message.exitCode === 'number' && message.exitCode !== 0,
        },
      })
      return
    }
    const text = messageText(message)
    if (text) items.push({ id: `${base}-status`, kind: 'status', text, timestamp: message.timestamp })
  })

  if (liveAssistant) {
    for (const block of liveAssistant.blocks) {
      if (!block.text) continue
      items.push({
        id: `${liveAssistant.id}-${block.kind}-${block.index}`,
        kind: block.kind === 'text' ? 'assistant' : 'thinking',
        text: block.text,
        streaming: true,
      })
    }
  }

  for (const liveTool of liveTools) {
    const index = toolIndexes.get(liveTool.id)
    if (index === undefined) {
      items.push({ id: `live-tool-${liveTool.id}`, kind: 'tool', tool: liveTool })
      continue
    }
    const existing = items[index]
    if (existing?.kind === 'tool') items[index] = { ...existing, tool: { ...existing.tool, ...liveTool } }
  }

  return items
}

export function messageText(message: PiMessage): string {
  return contentText(message.content)
}
