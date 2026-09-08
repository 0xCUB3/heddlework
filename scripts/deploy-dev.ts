import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export function parseDevHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(host => typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))) {
    throw new Error('dev-hosts.json must contain an array of SSH aliases')
  }
  return [...new Set(value)]
}

export function deployDevHosts(bundle: string): boolean {
  const config = resolve(homedir(), '.config/heddlework/dev-hosts.json')
  if (!existsSync(config)) return true
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, { stdio: ['ignore', 'inherit', 'inherit'] })
    if (result.exitCode !== 0) throw new Error(`${command[0]} failed (${result.exitCode})`)
  }
  try {
    const hosts = parseDevHosts(JSON.parse(readFileSync(config, 'utf8')))
    if (!hosts.length) return true
    const helper = resolve(import.meta.dir, '../dist/dev-runtime.js')
    run([process.execPath, 'build', resolve(import.meta.dir, 'dev-runtime.ts'), '--target=bun', `--outfile=${helper}`])
    for (const host of hosts) {
      console.log(`[install-dev] deploying to ${host}`)
      run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'mkdir -p ~/Applications/.heddlework-dev-staging'])
      run(['rsync', '-a', '--delete', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10', `${bundle}/`, `${host}:Applications/.heddlework-dev-staging/`])
      run(['scp', '-q', '-o', 'BatchMode=yes', helper, `${host}:Applications/.heddlework-dev-runtime.js`])
      run(['scp', '-q', '-o', 'BatchMode=yes', resolve(import.meta.dir, 'install-dev-remote.sh'), `${host}:Applications/.heddlework-dev-install.sh`])
      run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'bash ~/Applications/.heddlework-dev-install.sh'])
      console.log(`[install-dev] installed on ${host}`)
    }
    return true
  } catch (error) {
    console.error('[install-dev] remote deploy failed; rerun to retry:', error)
    return false
  }
}
