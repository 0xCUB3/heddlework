export interface UpdateCheckResult {
  available: boolean
  version?: string | undefined
  url?: string | undefined
  error?: string | undefined
}

export interface UpdateCheckOptions {
  currentVersion: string
  repository?: string | undefined
  fetch?: typeof fetch | undefined
  timeoutMs?: number | undefined
}

export const DEFAULT_UPDATE_REPOSITORY = '0xCUB3/heddlework'

// Asks GitHub for the latest release and reports whether its tag is newer than the running build. Never throws.
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const repository = options.repository ?? DEFAULT_UPDATE_REPOSITORY
  const fetchImpl = options.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000)
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `heddlework/${options.currentVersion}` },
      signal: controller.signal,
    })
    if (!response.ok) return { available: false, error: `GitHub responded ${response.status}` }
    const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
    if (typeof body.tag_name !== 'string' || body.draft === true) return { available: false }
    const latest = parseSemver(body.tag_name)
    const current = parseSemver(options.currentVersion)
    if (!latest || !current) return { available: false }
    const available = compareSemver(latest, current) > 0
    return { available, version: body.tag_name.replace(/^v/, ''), ...(typeof body.html_url === 'string' ? { url: body.html_url } : {}) }
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export function parseSemver(value: string): Semver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split('.') : [] }
}

export function compareSemver(left: Semver, right: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const numeric = /^\d+$/.test(a) && /^\d+$/.test(b)
    const order = numeric ? Number(a) - Number(b) : a.localeCompare(b)
    if (order !== 0) return order
  }
  return 0
}
