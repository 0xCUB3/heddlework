const SEARCH_ENDPOINT = 'https://www.google.com/search?q='

export function resolveBrowserAddress(value: string): string | undefined {
  const input = value.trim()
  if (!input) return undefined
  if (input === 'about:blank') return input
  if (/^https?:\/\//iu.test(input)) return safeHttpUrl(input)
  if (/^localhost(?::\d+)?(?:[/#?]|$)/iu.test(input) || /^127\.0\.0\.1(?::\d+)?(?:[/#?]|$)/u.test(input)) {
    return safeHttpUrl(`http://${input}`)
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(input)) return undefined
  if (looksLikeHost(input)) return safeHttpUrl(`https://${input}`)
  return `${SEARCH_ENDPOINT}${encodeURIComponent(input)}`
}

export function isBrowserUrlAllowed(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || value === 'about:blank'
  } catch {
    return false
  }
}

export function browserDisplayAddress(value: string): string {
  if (!value || value === 'about:blank') return ''
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return value
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return value
  }
}

function looksLikeHost(value: string): boolean {
  const host = value.split(/[/?#]/u, 1)[0] ?? ''
  return host.includes('.') && !/\s/u.test(value) && !host.startsWith('.') && !host.endsWith('.')
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}
