// Shared one-line "headline" argument for a tool call — the value shown beside
// a tool's name in collapsed previews (e.g. `fovea_focus <query>`). Core tools
// keep their path/command/pattern summaries; this picks up captured extension
// tools and other payloads so they no longer render as a bare name.
export const HEADLINE_ARG_KEYS = [
  'task', 'path', 'query', 'message', 'search', 'pattern', 'command', 'text',
  'prompt', 'question', 'input', 'content', 'expression', 'url', 'topic',
  'key', 'filter', 'name', 'q',
] as const

const HEADLINE_SKIP_KEYS = new Set([
  'label', 'title', 'type', 'kind', 'mode', 'format', 'resultFormat',
  'limit', 'max', 'offset', 'start', 'concurrency', 'overwrite', 'id',
  'provider', 'namespace', 'server', 'tool', 'ref', 'recursive', 'synthesize',
  'commandDigest',
])

const cleanOneLine = (value: string, max: number): string => {
  const single = value.replace(/\s+/g, ' ').trim()
  if (!single) return ''
  return single.length <= max ? single : `${single.slice(0, Math.max(1, max - 1))}…`
}

export function headlineArg(args: Record<string, unknown> | undefined, max = 96): string | undefined {
  if (!args) return undefined
  for (const key of HEADLINE_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string') {
      const cleaned = cleanOneLine(value, max)
      if (cleaned) return cleaned
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (HEADLINE_SKIP_KEYS.has(key)) continue
    if (typeof value === 'string') {
      const cleaned = cleanOneLine(value, max)
      if (cleaned) return cleaned
    }
  }
  return undefined
}
