// Thread titles: prompts, sanitizing, the auto-versus-manual guard, and context building. Browser-safe, no node imports.
//
// Modelled on t3code's flow: one generation after the first turn settles, a manual rename always wins, and an explicit
// 'Regenerate title' reads the whole thread with the previous title as an anchor.

import type { PiContentBlock, PiMessage } from '../pi/types.ts'

export const MAX_TITLE_LENGTH = 60
export const MAX_TITLE_CONTEXT_CHARS = 12_000
const MAX_FIRST_MESSAGE_CHARS = 4_000
const MAX_SECTION_CHARS = 2_500
const TRUNCATION_MARKER = '[Earlier content truncated]\n\n'

export interface ThreadTitleSettings {
  // Generate a title after the first turn of a new thread.
  autoTitles: boolean
  // 'provider/id' of the model used for titles; undefined picks a cheap model from the session provider.
  titleModel?: string | undefined
  // Extra house rules appended to both prompts.
  instructions?: string | undefined
}

export const DEFAULT_THREAD_TITLE_SETTINGS: ThreadTitleSettings = { autoTitles: true }

export function normalizeThreadTitleSettings(value: unknown): ThreadTitleSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_THREAD_TITLE_SETTINGS }
  const source = value as Record<string, unknown>
  const titleModel = typeof source.titleModel === 'string' && source.titleModel.trim() ? source.titleModel.trim() : undefined
  const instructions = typeof source.instructions === 'string' && source.instructions.trim() ? source.instructions.trim().slice(0, 4_000) : undefined
  return {
    autoTitles: source.autoTitles !== false,
    ...(titleModel ? { titleModel } : {}),
    ...(instructions ? { instructions } : {}),
  }
}

const EDITORIAL_RULES = [
  '- 3-8 words, fewer than 40 characters.',
  '- Use a compact noun phrase or clear action phrase.',
  '- Capture the umbrella goal when the request lists several symptoms or steps.',
  '- Name the product change, not the mock, plan, report, branch, or PR used to produce it.',
  '- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.',
  '- For reviews, name what is being reviewed and the relevant concern, not a generic "Review PR 123".',
  '- For research, name the question domain rather than the requested research process.',
  '- Do not claim the work is complete.',
  '- Do not copy and truncate the user\'s message.',
  '- Avoid project names already visible in the UI, quotes, labels, filler, and trailing punctuation.',
  '- Local git history is not evidence of what a linked PR or issue is about; never title after branch names or commit messages.',
  '- If a linked PR or issue cannot be read, fall back to the user\'s stated action plus its number, such as "Take Over PR 8588".',
]

function instructionsSection(instructions: string | undefined): string[] {
  const trimmed = instructions?.trim()
  return trimmed ? ['', 'Additional instructions:', trimmed] : []
}

export function initialTitlePrompt(message: string, settings: Pick<ThreadTitleSettings, 'instructions'> = {}): string {
  return [
    'Generate a title that will help the user recognize this coding thread weeks later.',
    'Return JSON with exactly one key: title.',
    '',
    'Before answering, silently reduce the request to:',
    '- Subject: What system, feature, or problem is this really about?',
    '- Outcome: What does the user ultimately want to understand or change?',
    '- Incidental instructions: What only describes how the agent should do the work?',
    '',
    'Title the subject and outcome. Discard incidental instructions.',
    '',
    'Editorial rules:',
    ...EDITORIAL_RULES,
    ...instructionsSection(settings.instructions),
    '',
    'Thread:',
    message,
  ].join('\n')
}

export function regenerateTitlePrompt(message: string, previousTitle: string, settings: Pick<ThreadTitleSettings, 'instructions'> = {}): string {
  return [
    'Regenerate the title for an existing coding thread so the user can recognize it weeks later.',
    `The previous title was ${JSON.stringify(previousTitle)}.`,
    'Return JSON with exactly one key: title.',
    '',
    'Determine the title in this order:',
    '1. Read the USER messages first. Identify the latest explicit durable goal. The original subject remains the subject until the user clearly changes what the thread is about.',
    '2. Use ASSISTANT messages to resolve vague links, unnamed code, and discovered product nouns. Do not promote one assistant finding into the thread subject unless the user adopts it as a new goal.',
    '3. Compare that subject with the previous title. Preserve accurate scope words, especially when earlier content is truncated. Replace the previous title when it is generic, artifact-based, or a copy of a message.',
    '4. Title the durable subject and desired outcome, not the current workflow state.',
    '',
    'Editorial rules:',
    ...EDITORIAL_RULES,
    '- Preserve the umbrella subject when later messages focus on one finding, provider, platform, or implementation detail.',
    '- A thread progressing through research, planning, implementation, review, CI, merge, and monitoring has usually not changed subjects.',
    '- Treat final operational follow-ups and assistant completion summaries as weak evidence of subject.',
    '- Return a meaningfully improved title, not a cosmetic paraphrase of the previous title.',
    ...instructionsSection(settings.instructions),
    '',
    'Thread:',
    message,
  ].join('\n')
}

// Strips a JSON wrapper, OSC/ANSI noise from a terminal-oriented model runner, quotes, and whitespace. Empty when unusable.
export function sanitizeThreadTitle(raw: string): string {
  const cleaned = raw.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  const decoded = decodeJsonTitle(cleaned)
  const title = (decoded ?? cleaned)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
  const normalized = title
    .replace(/^(?:title\s*[:=]\s*)/i, '')
    .replace(/^['"`\u201c\u2018]+|['"`\u201d\u2019.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return ''
  if (normalized.length <= MAX_TITLE_LENGTH) return normalized
  const cut = normalized.slice(0, MAX_TITLE_LENGTH)
  const boundary = cut.lastIndexOf(' ')
  return (boundary > 20 ? cut.slice(0, boundary) : cut).trim()
}

function decodeJsonTitle(text: string): string | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { title?: unknown }
    return typeof parsed.title === 'string' ? parsed.title : undefined
  } catch {
    return undefined
  }
}

export type ThreadTitleSource = 'auto' | 'manual'

// An auto title may only land on a thread nobody renamed by hand. A manual rename is permanent until the user asks to regenerate.
export function canApplyAutoTitle(input: { titleSource?: ThreadTitleSource | undefined; sessionName?: string | undefined }): boolean {
  if (input.titleSource === 'manual') return false
  if (input.titleSource === 'auto') return true
  // No record: only an unnamed session is safe to title.
  return !input.sessionName?.trim()
}

export function messageText(message: PiMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((block: PiContentBlock) => (block.type === 'text' || block.type === undefined) && typeof block.text === 'string' ? block.text : '')
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

function limit(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\u2026`
}

function section(message: PiMessage, max = MAX_SECTION_CHARS): string | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') return undefined
  if (message.display === false || (message.customType && message.role === 'user')) return undefined
  const text = messageText(message)
  if (!text.trim()) return undefined
  return `${message.role.toUpperCase()}:\n${limit(text, max)}`
}

// The first user message is the subject anchor. Fill the rest of the budget from the newest messages backwards.
export function buildTitleContext(messages: readonly PiMessage[], budget = MAX_TITLE_CONTEXT_CHARS): string {
  const firstUser = messages.find((message) => message.role === 'user' && section(message))
  const pinned = firstUser ? section(firstUser, MAX_FIRST_MESSAGE_CHARS) : undefined
  const recent: string[] = []
  let used = pinned ? pinned.length + 2 : 0
  let truncated = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message === firstUser) continue
    const text = section(message)
    if (!text) continue
    if (used + text.length + 2 > budget) { truncated = true; break }
    recent.unshift(text)
    used += text.length + 2
  }
  const parts = [...(pinned ? [pinned] : []), ...recent]
  const body = parts.join('\n\n')
  return truncated && pinned ? `${pinned}\n\n${TRUNCATION_MARKER}${recent.join('\n\n')}` : truncated ? `${TRUNCATION_MARKER}${body}` : body
}

export function firstUserMessageText(messages: readonly PiMessage[]): string {
  const first = messages.find((message) => message.role === 'user' && section(message))
  return first ? limit(messageText(first), MAX_FIRST_MESSAGE_CHARS) : ''
}

// Picks a cheap model on the session's provider; the caller validates against the runtime model list.
export const CHEAP_MODEL_PREFERENCES: Record<string, readonly string[]> = {
  anthropic: ['claude-haiku-4-5', 'claude-3-5-haiku-latest'],
  openai: ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'],
  'openai-codex': ['gpt-5-mini', 'gpt-5-codex-mini'],
  google: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3-flash'],
  antigravity: ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
  xai: ['grok-4-fast-non-reasoning', 'grok-3-mini', 'grok-4.1-fast-non-reasoning'],
  groq: ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'],
  openrouter: ['google/gemini-2.5-flash-lite', 'openai/gpt-4.1-mini'],
}

export function pickTitleModel(input: { settings: ThreadTitleSettings; sessionModel: { provider: string; id: string } | null | undefined; available: readonly { provider: string; id: string }[] }): string | undefined {
  if (input.settings.titleModel) return input.settings.titleModel
  const provider = input.sessionModel?.provider
  if (!provider) return undefined
  const ids = new Set(input.available.filter((model) => model.provider === provider).map((model) => model.id))
  for (const candidate of CHEAP_MODEL_PREFERENCES[provider] ?? []) {
    if (ids.size === 0 || ids.has(candidate)) return `${provider}/${candidate}`
  }
  return input.sessionModel ? `${provider}/${input.sessionModel.id}` : undefined
}
