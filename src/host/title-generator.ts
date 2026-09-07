// Generates thread titles by shelling out to `pi -p --no-session --model …`, so every provider pi can talk to works
// without a second credential store. Runs on the machine that owns the runtime.

import { spawn } from 'node:child_process'
import { piProcessEnvironment, resolvePiExecutable } from '../pi/rpc-transport.ts'
import { initialTitlePrompt, regenerateTitlePrompt, sanitizeThreadTitle, type ThreadTitleSettings } from '../workbench/thread-titles.ts'

export interface TitleGenerationRequest {
  // 'provider/id'
  model: string
  context: string
  previousTitle?: string | undefined
  cwd?: string | undefined
  settings?: Pick<ThreadTitleSettings, 'instructions'> | undefined
  signal?: AbortSignal | undefined
}

export interface TitleGenerator {
  generate(request: TitleGenerationRequest): Promise<string>
}

export interface PiTitleGeneratorOptions {
  command?: string | undefined
  timeoutMs?: number | undefined
  env?: NodeJS.ProcessEnv | undefined
}

export function createPiTitleGenerator(options: PiTitleGeneratorOptions = {}): TitleGenerator {
  const timeoutMs = options.timeoutMs ?? 45_000
  return {
    async generate(request) {
      const prompt = request.previousTitle
        ? regenerateTitlePrompt(request.context, request.previousTitle, request.settings ?? {})
        : initialTitlePrompt(request.context, request.settings ?? {})
      const raw = await runPiPrint({ command: options.command, model: request.model, prompt, cwd: request.cwd, timeoutMs, env: options.env, signal: request.signal })
      const title = sanitizeThreadTitle(raw)
      if (!title) throw new Error('The title model returned nothing usable')
      return title
    },
  }
}

interface PiPrintInput {
  command?: string | undefined
  model: string
  prompt: string
  cwd?: string | undefined
  timeoutMs: number
  env?: NodeJS.ProcessEnv | undefined
  signal?: AbortSignal | undefined
}

export function runPiPrint(input: PiPrintInput): Promise<string> {
  const command = input.command ?? resolvePiExecutable()
  const args = ['-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--model', input.model, '--thinking', 'off', input.prompt]
  const env = piProcessEnvironment(command, { ...process.env, ...input.env })
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: input.cwd ?? process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(stdout)
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`Title generation timed out after ${Math.round(input.timeoutMs / 1000)}s`)) }, input.timeoutMs)
    const onAbort = () => { child.kill('SIGKILL'); finish(new Error('Title generation cancelled')) }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer | string) => { stdout = `${stdout}${chunk.toString()}`.slice(-20_000) })
    child.stderr.on('data', (chunk: Buffer | string) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000) })
    child.once('error', (error) => finish(new Error(`Unable to start pi for title generation: ${error.message}`)))
    child.once('exit', (code) => {
      if (code === 0) finish()
      else finish(new Error(stderr.trim().split('\n').pop() || `pi exited with code ${code}`))
    })
  })
}
