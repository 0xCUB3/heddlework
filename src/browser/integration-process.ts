import { spawn } from 'node:child_process'

export interface BrowserProcessRequest {
  command: string
  args: string[]
  input?: string
  signal: AbortSignal
  onOutput(text: string): void
}
export type BrowserProcessRunner = (request: BrowserProcessRequest) => Promise<void>

// No shell interpolation. Output is bounded, and killing the local process is not
// represented as proof that a remote browser agent has stopped.
export const runBrowserProcess: BrowserProcessRunner = ({ command, args, input, signal, onOutput }) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('Browser task interrupted')); return }
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  let bytes = 0
  let settled = false
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', abort)
    error ? reject(error) : resolve()
  }
  const abort = () => { child.kill('SIGKILL'); finish(new Error('Local browser connection interrupted; remote work may continue.')) }
  signal.addEventListener('abort', abort, { once: true })
  const output = (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 128 * 1024) { child.kill('SIGKILL'); finish(new Error('Browser output limit exceeded; remote work may continue.')); return }
    onOutput(chunk.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))
  }
  child.stdout.on('data', output)
  child.stderr.on('data', output)
  child.stdin.on('error', () => {})
  child.on('error', finish)
  child.on('close', (code) => finish(code === 0 ? undefined : new Error(`Browser process exited ${code ?? 'after a signal'}`)))
  child.stdin.end(input ?? '')
})
