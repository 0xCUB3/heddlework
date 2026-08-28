import type { PiForkMessage, PiImageContent, PiMessage } from '../pi/types.ts'
import { asRecord, contentText, type LiveAssistant, type ToolRun } from './state.ts'

interface RevertibleItem {
  revertEntryId?: string | undefined
}

export type TimelineItem =
  | ({ id: string; kind: 'user'; text: string; images: PiImageContent[]; timestamp?: number | undefined } & RevertibleItem)
  | ({ id: string; kind: 'assistant'; text: string; streaming?: boolean; timestamp?: number | undefined } & RevertibleItem)
  | ({ id: string; kind: 'thinking'; text: string; streaming?: boolean; timestamp?: number | undefined } & RevertibleItem)
  | ({ id: string; kind: 'context-injection'; text: string; images: PiImageContent[]; source?: string | undefined; timestamp?: number | undefined } & RevertibleItem)
  | ({ id: string; kind: 'tool'; tool: ToolRun; timestamp?: number | undefined } & RevertibleItem)
  | ({ id: string; kind: 'status'; text: string; tone?: 'normal' | 'error'; timestamp?: number | undefined } & RevertibleItem)

export function buildTimeline(
  messages: PiMessage[],
  liveAssistant: LiveAssistant | undefined,
  liveTools: ToolRun[],
  forkMessages: PiForkMessage[] = [],
  messageIndexOffset = 0,
): TimelineItem[] {
  const items: TimelineItem[] = []
  const toolIndexes = new Map<string, number>()
  let userMessageIndex = 0
  let revertEntryId: string | undefined
  const forkMessagesByEntryId = new Map(forkMessages.map((message) => [message.entryId, message]))

  messages.forEach((message, localMessageIndex) => {
    if (message.role === 'custom' && message.display !== true) return
    const messageIndex = messageIndexOffset + localMessageIndex
    const entryId = typeof message.workbenchEntryId === 'string' ? message.workbenchEntryId : undefined
    const base = entryId ? `entry-${entryId}` : `${message.timestamp ?? messageIndex}-${messageIndex}`
    if (message.role === 'custom') {
      const text = messageText(message)
      const images = messageImages(message)
      if (text || images.length > 0) items.push({ id: `${base}-context`, kind: 'context-injection', text, images, ...(message.customType ? { source: message.customType } : {}), timestamp: message.timestamp, ...(revertEntryId ? { revertEntryId } : {}) })
      return
    }
    if (message.role === 'user') {
      const positionalForkMessage = forkMessages[userMessageIndex++]
      const forkMessage = entryId ? forkMessagesByEntryId.get(entryId) : positionalForkMessage
      revertEntryId = forkMessage?.entryId ?? entryId
      items.push({
        id: `${base}-user`,
        kind: 'user',
        text: messageText(message),
        images: messageImages(message),
        timestamp: message.timestamp,
        ...(revertEntryId ? { revertEntryId } : {}),
      })
      return
    }
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        if (message.content) items.push({ id: `${base}-assistant`, kind: 'assistant', text: message.content, timestamp: message.timestamp, ...(revertEntryId ? { revertEntryId } : {}) })
        return
      }
      for (const [blockIndex, candidate] of (message.content ?? []).entries()) {
        const block = asRecord(candidate)
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          items.push({ id: `${base}-text-${blockIndex}`, kind: 'assistant', text: block.text, timestamp: message.timestamp, ...(revertEntryId ? { revertEntryId } : {}) })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          items.push({ id: `${base}-thinking-${blockIndex}`, kind: 'thinking', text: block.thinking, timestamp: message.timestamp, ...(revertEntryId ? { revertEntryId } : {}) })
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
          items.push({ id: `tool-${id}`, kind: 'tool', tool, timestamp: message.timestamp, ...(revertEntryId ? { revertEntryId } : {}) })
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
        items.push({ id: `tool-${id}`, kind: 'tool', tool: result, timestamp: message.timestamp, ...(revertEntryId ? { revertEntryId } : {}) })
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
        ...(revertEntryId ? { revertEntryId } : {}),
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
    if (text) items.push({ id: `${base}-status`, kind: 'status', text, timestamp: message.timestamp, ...(revertEntryId ? { revertEntryId } : {}) })
  })

  if (liveAssistant) {
    for (const block of liveAssistant.blocks) {
      if (!block.text) continue
      items.push({
        id: `${liveAssistant.id}-${block.kind}-${block.index}`,
        kind: block.kind === 'text' ? 'assistant' : 'thinking',
        text: block.text,
        streaming: true,
        ...(revertEntryId ? { revertEntryId } : {}),
      })
    }
  }

  for (const liveTool of liveTools) {
    const index = toolIndexes.get(liveTool.id)
    if (index === undefined) {
      items.push({ id: `live-tool-${liveTool.id}`, kind: 'tool', tool: liveTool, ...(revertEntryId ? { revertEntryId } : {}) })
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

function messageImages(message: PiMessage): PiImageContent[] {
  if (!Array.isArray(message.content)) return []
  return message.content.filter((block): block is PiImageContent => (
    block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
  ))
}
