import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Bumps package.json, commits, and tags v<version>. Usage: bun scripts/release-tag.ts <patch|minor|major|x.y.z[-pre]>
const root = resolve(import.meta.dir, '..')
const packagePath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }
const request = process.argv[2] ?? 'patch'
const next = bump(pkg.version, request)

run(['git', 'diff', '--quiet'], 'Working tree must be clean before tagging')
pkg.version = next
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
run(['git', 'add', 'package.json'])
run(['git', 'commit', '-q', '-m', `chore(release): v${next}`])
run(['git', 'tag', '-a', `v${next}`, '-m', `Heddlework v${next}`])
console.log(`Tagged v${next}. Push with: git push origin main --follow-tags`)

function bump(current: string, request: string): string {
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(request)) return request
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current)
  if (!match) throw new Error(`Cannot parse current version ${current}`)
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (request === 'major') return `${major + 1}.0.0`
  if (request === 'minor') return `${major}.${minor + 1}.0`
  if (request === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`Unknown bump ${request}; use patch, minor, major, or an explicit version`)
}

function run(command: string[], failure?: string): void {
  const result = Bun.spawnSync(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) throw new Error(failure ?? `${command.join(' ')} failed`)
}
