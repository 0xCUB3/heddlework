import { compareSemver, parseSemver, type Semver } from './check.ts'

export type UpdateChannel = 'stable' | 'prerelease'

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface ReleaseInfo {
  version: string
  tag: string
  url: string
  prerelease: boolean
  notes: string
  assets: ReleaseAsset[]
}

export interface ReleaseFeedOptions {
  repository: string
  channel: UpdateChannel
  currentVersion: string
  fetch?: typeof fetch | undefined
  timeoutMs?: number | undefined
}

interface GitHubRelease {
  tag_name?: unknown
  html_url?: unknown
  draft?: unknown
  prerelease?: unknown
  body?: unknown
  assets?: unknown
}

function toRelease(raw: GitHubRelease): (ReleaseInfo & { semver: Semver }) | undefined {
  if (typeof raw.tag_name !== 'string' || raw.draft === true) return undefined
  const semver = parseSemver(raw.tag_name)
  if (!semver) return undefined
  const assets = Array.isArray(raw.assets)
    ? raw.assets.flatMap((asset: { name?: unknown; browser_download_url?: unknown; size?: unknown }) =>
        typeof asset?.name === 'string' && typeof asset.browser_download_url === 'string'
          ? [{ name: asset.name, url: asset.browser_download_url, size: typeof asset.size === 'number' ? asset.size : 0 }]
          : [],
      )
    : []
  return {
    semver,
    version: raw.tag_name.replace(/^v/, ''),
    tag: raw.tag_name,
    url: typeof raw.html_url === 'string' ? raw.html_url : '',
    prerelease: raw.prerelease === true,
    notes: typeof raw.body === 'string' ? raw.body : '',
    assets,
  }
}

// Resolves the newest release on a channel. Stable reads releases/latest; prerelease scans the recent list and keeps the highest semver. Throws on transport failure so the caller can surface it.
export async function fetchLatestRelease(options: ReleaseFeedOptions): Promise<ReleaseInfo | undefined> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  const path = options.channel === 'stable' ? 'releases/latest' : 'releases?per_page=20'
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${options.repository}/${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `heddlework/${options.currentVersion}` },
      signal: controller.signal,
    })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`GitHub responded ${response.status}`)
    const body = (await response.json()) as GitHubRelease | GitHubRelease[]
    const candidates = (Array.isArray(body) ? body : [body]).flatMap((raw) => toRelease(raw) ?? [])
    const newest = candidates.sort((a, b) => compareSemver(b.semver, a.semver))[0]
    if (!newest) return undefined
    const { semver: _semver, ...release } = newest
    return release
  } finally {
    clearTimeout(timer)
  }
}

// True when the release is newer than the running build. Stable ignores prerelease tags so a user on stable never sees an rc.
export function isNewerRelease(release: ReleaseInfo, currentVersion: string, channel: UpdateChannel): boolean {
  if (channel === 'stable' && release.prerelease) return false
  const latest = parseSemver(release.tag)
  const current = parseSemver(currentVersion)
  if (!latest || !current) return false
  return compareSemver(latest, current) > 0
}
