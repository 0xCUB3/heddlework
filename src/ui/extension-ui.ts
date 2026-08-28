export interface ParsedExtensionOption {
  value: string
  label: string
  detail?: string
  ordinal?: string
}

export interface ParsedExtensionTitle {
  title: string
  detail?: string
}

const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g

export function plainExtensionText(value: string): string {
  return value.replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARACTER, '')
}

export function parseExtensionTitle(value: string): ParsedExtensionTitle {
  const normalized = plainExtensionText(value).trim()
  const newline = normalized.indexOf('\n')
  if (newline < 0) return { title: normalized }
  const title = normalized.slice(0, newline).trim()
  const detail = normalized.slice(newline + 1).trim()
  return { title, ...(detail ? { detail } : {}) }
}

export function parseExtensionOption(value: string): ParsedExtensionOption {
  const normalized = plainExtensionText(value).trim()
  const numbered = /^(\d+)\.\s+(.+)$/.exec(normalized)
  const ordinal = numbered?.[1]
  const content = numbered?.[2] ?? normalized
  const dash = content.indexOf(' — ')
  const heading = dash < 0 ? content : content.slice(0, dash).trim()
  const description = dash < 0 ? '' : content.slice(dash + 3).trim()
  const metadata = heading.indexOf(' · ')
  const label = metadata < 0 ? heading : heading.slice(0, metadata).trim()
  const current = metadata < 0 ? '' : heading.slice(metadata + 3).trim()
  const detail = [current, description].filter(Boolean).join(' · ')
  return {
    value,
    label,
    ...(detail ? { detail } : {}),
    ...(ordinal ? { ordinal } : {}),
  }
}

export function filterExtensionOptions(options: readonly ParsedExtensionOption[], query: string): ParsedExtensionOption[] {
  const terms = normalize(query).split(' ').filter(Boolean)
  if (terms.length === 0) return [...options]
  return options.filter((option) => {
    const haystack = normalize(`${option.label} ${option.detail ?? ''} ${option.value}`)
    return terms.every((term) => haystack.includes(term))
  })
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
