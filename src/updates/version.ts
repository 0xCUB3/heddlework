declare const __HEDDLEWORK_VERSION__: string | undefined

// scripts/build.ts defines __HEDDLEWORK_VERSION__ from package.json; source runs fall back to reading it directly.
export function currentAppVersion(): string {
  if (typeof __HEDDLEWORK_VERSION__ === 'string' && __HEDDLEWORK_VERSION__) return __HEDDLEWORK_VERSION__
  return process.env.HEDDLEWORK_VERSION ?? '0.0.0-dev'
}
