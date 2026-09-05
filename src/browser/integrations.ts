import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { browserDataRoot } from './persistence.ts'
import { runBrowserProcess, type BrowserProcessRunner } from './integration-process.ts'
import { isBrowserIntegrationCommand, type BrowserIntegrationCommand, type BrowserIntegrationSnapshot, type BrowserIntegrationChoice } from './integration-types.ts'

export interface BrowserTaskAdapter {
  readonly choice: BrowserIntegrationChoice
  run(request: { profile: string; prompt: string; signal: AbortSignal; onOutput(text: string): void }): Promise<void>
}
export interface CustomBrowserAdapterConfig { id: string; label: string; command: string; args: string[]; description: string }

export function loadCustomBrowserAdapters(path: string): CustomBrowserAdapterConfig[] {
  if (!existsSync(path)) return []
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (data.version !== 1 || !Array.isArray(data.adapters) || data.adapters.length > 20) throw new Error('Invalid browser integrations config')
  const ids = new Set(['builtin', 'aside'])
  return data.adapters.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid browser adapter')
    const v = value as Record<string, unknown>
    if (typeof v.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(v.id) || ids.has(v.id)
      || typeof v.label !== 'string' || !v.label.trim() || v.label.length > 100
      || typeof v.command !== 'string' || !isAbsolute(v.command)
      || !Array.isArray(v.args) || v.args.length > 40 || !v.args.every(a => typeof a === 'string' && a.length < 4000)
      || typeof v.description !== 'string' || v.description.length > 1000) throw new Error('Invalid browser adapter configuration; use unique IDs and absolute executables')
    ids.add(v.id)
    return { id: v.id, label: v.label, command: v.command, args: v.args as string[], description: v.description }
  })
}

export function resolveAsideExecutable(): string {
  return Bun.which('aside') ?? [join(homedir(), '.local/bin/aside'), '/opt/homebrew/bin/aside', '/usr/local/bin/aside'].find(existsSync) ?? '/usr/local/bin/aside'
}

export function createBrowserTaskAdapters(config: CustomBrowserAdapterConfig[], runner: BrowserProcessRunner = runBrowserProcess, asideCommand = resolveAsideExecutable()): BrowserTaskAdapter[] {
  return [{
    choice: { id: 'aside', label: 'Aside', available: existsSync(asideCommand), description: 'Access the selected Aside account’s logged-in browser on this host. No tab-level sandbox. Requires Aside running and signed in.' },
    run: ({ profile, prompt, signal, onOutput }) => {
      if (!/^u\d+$/.test(profile)) throw new Error('Choose an explicit Aside account ID, such as u0. Run aside account on the host to find it.')
      return runner({ command: asideCommand, args: ['exec', '--host', 'local', '--account', profile, '--permission', 'guard', '--', `User-approved browser task:\n${prompt}\n\nStay within this task. Do not send messages, purchase, delete, or change account settings unless explicitly requested above. Never export cookies or credentials.`], signal, onOutput })
    },
  }, ...config.map((adapter): BrowserTaskAdapter => ({
    choice: { id: adapter.id, label: adapter.label, available: existsSync(adapter.command), description: adapter.description },
    run: ({ profile, prompt, signal, onOutput }) => runner({ command: adapter.command, args: adapter.args, input: JSON.stringify({ version: 1, profile, prompt }) + '\n', signal, onOutput }),
  }))]
}

export class BrowserIntegrationService {
  #adapters: Map<string, BrowserTaskAdapter>
  #state: BrowserIntegrationSnapshot
  #listeners = new Set<() => void>()
  #abort: AbortController | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false
  constructor(private options: { adapters: BrowserTaskAdapter[]; preferencePath?: string | false; error?: string; timeoutMs?: number; now?: () => number }) {
    this.#adapters = new Map(options.adapters.map(a => [a.choice.id, a]))
    if (this.#adapters.size !== options.adapters.length || this.#adapters.has('builtin')) throw new Error('Duplicate or reserved browser adapter ID')
    this.#state = { choices: [{ id: 'builtin', label: 'Built-in browser', available: true, description: 'Isolated app-owned browser on the GPUix desktop. External task automation is off.' }, ...options.adapters.map(a => a.choice)], selectedId: 'builtin', profile: '', task: null, error: options.error ?? null }
    if (options.preferencePath && existsSync(options.preferencePath)) {
      try {
        const saved = JSON.parse(readFileSync(options.preferencePath, 'utf8'))
        if (isBrowserIntegrationCommand({ ...saved, type: 'selectBrowserIntegration' }) && (saved.integrationId === 'builtin' || this.#adapters.has(saved.integrationId))) {
          this.#state = { ...this.#state, selectedId: saved.integrationId, profile: saved.profile }
        }
      } catch { this.#state.error = 'Could not read saved browser selection; built-in remains selected.' }
    }
  }
  getSnapshot = (): BrowserIntegrationSnapshot => this.#state
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  #set(patch: Partial<BrowserIntegrationSnapshot>) { this.#state = { ...this.#state, ...patch }; for (const listener of this.#listeners) listener() }
  dispatch(command: BrowserIntegrationCommand): void {
    if (this.#disposed) throw new Error('Browser service closed')
    if (!isBrowserIntegrationCommand(command)) throw new Error('Invalid browser integration command')
    const task = this.#state.task
    switch (command.type) {
      case 'selectBrowserIntegration': {
        if (task?.status === 'running') throw new Error('Stop the current browser task before switching')
        if (!this.#state.choices.some(c => c.id === command.integrationId)) throw new Error('Unknown browser integration')
        if (command.integrationId === 'aside' && !/^u\d+$/.test(command.profile)) throw new Error('Enter an explicit Aside account ID, such as u0')
        const profile = command.integrationId === 'builtin' ? '' : command.profile.trim()
        if (command.integrationId !== 'builtin' && !profile) throw new Error('Choose a profile explicitly')
        if (this.options.preferencePath) {
          mkdirSync(dirname(this.options.preferencePath), { recursive: true })
          const temporary = `${this.options.preferencePath}.${process.pid}.tmp`
          writeFileSync(temporary, JSON.stringify({ integrationId: command.integrationId, profile }), { mode: 0o600 })
          renameSync(temporary, this.options.preferencePath)
        }
        this.#set({ selectedId: command.integrationId, profile, task: null })
        return
      }
      case 'requestBrowserTask': {
        if (task?.status === 'running' || task?.status === 'review') throw new Error('Finish or cancel the current task first')
        const adapter = this.#adapters.get(this.#state.selectedId)
        if (!adapter?.choice.available) throw new Error('Select an available external browser first; built-in browsing remains in the desktop pane')
        if (!this.#state.profile) throw new Error('Choose a profile explicitly')
        this.#set({ task: { id: crypto.randomUUID(), integrationId: adapter.choice.id, profile: this.#state.profile, prompt: command.prompt.trim(), status: 'review', output: '', expiresAt: (this.options.now?.() ?? Date.now()) + 5 * 60_000 } })
        return
      }
      case 'approveBrowserTask': {
        if (!task || task.id !== command.id || task.status !== 'review') throw new Error('No matching task awaiting approval')
        if (task.expiresAt <= (this.options.now?.() ?? Date.now())) throw new Error('Approval expired; cancel and request the task again')
        const adapter = this.#adapters.get(task.integrationId)
        if (!adapter?.choice.available) throw new Error('Browser adapter unavailable')
        this.#abort = new AbortController()
        const signal = this.#abort.signal
        this.#set({ task: { ...task, status: 'running' } })
        this.#timer = setTimeout(() => this.#interrupt('Time limit reached. The browser may still be working; stop it in the browser application.'), this.options.timeoutMs ?? 5 * 60_000)
        void Promise.resolve().then(() => {
          if (signal.aborted) return
          return adapter.run({ profile: task.profile, prompt: task.prompt, signal, onOutput: text => {
            const current = this.#state.task
            if (current?.id !== task.id || current.status !== 'running') return
            this.#set({ task: { ...current, output: (current.output + text).slice(-128 * 1024) } })
          } })
        }).then(() => this.#finish(task.id, 'completed'), error => this.#finish(task.id, 'failed', error instanceof Error ? error.message : String(error)))
        return
      }
      case 'cancelBrowserTask':
        if (!task || task.id !== command.id) throw new Error('Unknown browser task')
        if (task.status === 'running') this.#interrupt('Local connection stopped. Remote browser work may continue; stop it in Aside or your browser adapter.')
        else if (task.status === 'review') this.#set({ task: { ...task, status: 'cancelled' } })
        return
      case 'clearBrowserTask':
        if (task?.status === 'running') throw new Error('Stop the browser task before clearing it')
        this.#set({ task: null }); return
    }
  }
  #finish(id: string, status: 'completed' | 'failed', error?: string) {
    const task = this.#state.task
    if (task?.id !== id || task.status !== 'running') return
    clearTimeout(this.#timer); this.#abort = undefined
    this.#set({ task: { ...task, status, output: error ? task.output + '\n' + error : task.output } })
  }
  #interrupt(message: string) {
    const task = this.#state.task
    if (!task || task.status !== 'running') return
    clearTimeout(this.#timer)
    this.#set({ task: { ...task, status: 'detached', output: task.output + '\n' + message } })
    this.#abort?.abort(); this.#abort = undefined
  }
  dispose() { this.#interrupt('Host stopped. Remote browser work may continue.'); this.#disposed = true; this.#listeners.clear() }
}

export function createBrowserIntegrationService(environment: NodeJS.ProcessEnv = process.env): BrowserIntegrationService {
  const root = browserDataRoot(process.platform, environment)
  const configPath = environment.HEDDLEWORK_BROWSER_ADAPTERS ?? join(root, 'integrations.json')
  let config: CustomBrowserAdapterConfig[] = []
  let error: string | undefined
  try { config = loadCustomBrowserAdapters(configPath) } catch (e) { error = `Browser adapters were not loaded: ${e instanceof Error ? e.message : String(e)}` }
  return new BrowserIntegrationService({ adapters: createBrowserTaskAdapters(config), preferencePath: environment.HEDDLEWORK_DEMO === '1' ? false : join(root, 'integration-selection.json'), ...(error ? { error } : {}) })
}
