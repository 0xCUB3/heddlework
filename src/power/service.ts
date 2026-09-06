import type { BrowserIntegrationService } from '../browser/integrations.ts'
import type { FlowRuntime } from '../flows/runtime.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { hostWorkIsRunning, shouldInhibitSleep } from './activity.ts'
import {
  createPlatformSleepBackend,
  loadWindowsSetThreadExecutionState,
  type HeldSleepAssertion,
  type SleepBackend,
} from './backends.ts'
import { readSleepPreventionPolicy, writeSleepPreventionPolicy } from './preferences.ts'
import {
  parseSleepPreventionPolicy,
  type SleepPreventionPolicy,
  type SleepPreventionSnapshot,
} from './types.ts'

export interface SleepPreventionSources {
  controller: Pick<WorkbenchController, 'subscribe' | 'getSnapshot'>
  flows?: Pick<FlowRuntime, 'subscribe' | 'getSnapshot'> | undefined
  browserIntegrations?: Pick<BrowserIntegrationService, 'subscribe' | 'getSnapshot'> | undefined
}

export interface SleepPreventionServiceOptions extends SleepPreventionSources {
  preferencePath?: string | false | undefined
  backend?: SleepBackend | undefined
  releaseDebounceMs?: number | undefined
  now?: (() => number) | undefined
}

const RELEASE_DEBOUNCE_MS = 300
const RESTART_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000]

export class SleepPreventionService {
  readonly #sources: SleepPreventionSources
  readonly #preferencePath: string | false
  readonly #releaseDebounceMs: number
  readonly #listeners = new Set<() => void>()
  #backend: SleepBackend
  #policy: SleepPreventionPolicy
  #held: HeldSleepAssertion | undefined
  #stopHeld: (() => void) | undefined
  #snapshot: SleepPreventionSnapshot
  #unsubscribers: Array<() => void> = []
  #reconcileChain: Promise<void> = Promise.resolve()
  #generation = 0
  #releaseTimer: ReturnType<typeof setTimeout> | undefined
  #restartTimer: ReturnType<typeof setTimeout> | undefined
  #restartAttempts = 0
  #disposed = false
  #heldDisplay = false

  constructor(options: SleepPreventionServiceOptions) {
    this.#sources = options
    this.#preferencePath = options.preferencePath === undefined ? false : options.preferencePath
    this.#releaseDebounceMs = options.releaseDebounceMs ?? RELEASE_DEBOUNCE_MS
    this.#backend = options.backend ?? createPlatformSleepBackend()
    this.#policy = readSleepPreventionPolicy(this.#preferencePath)
    this.#snapshot = this.#buildSnapshot('idle', this.#working())
    this.#unsubscribers.push(options.controller.subscribe(() => this.#queueReconcile()))
    if (options.flows) this.#unsubscribers.push(options.flows.subscribe(() => this.#queueReconcile()))
    if (options.browserIntegrations) this.#unsubscribers.push(options.browserIntegrations.subscribe(() => this.#queueReconcile()))
    this.#queueReconcile()
    if (!options.backend && process.platform === 'win32') {
      void loadWindowsSetThreadExecutionState().then((setState) => {
        if (this.#disposed || !setState) return
        this.#backend = createPlatformSleepBackend({ windowsSetThreadExecutionState: setState })
        this.#snapshot = this.#buildSnapshot(this.#snapshot.status, this.#working(), this.#snapshot.error)
        this.#emit()
        this.#queueReconcile()
      })
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): SleepPreventionSnapshot => this.#snapshot

  setPolicy(policy: SleepPreventionPolicy): void {
    const next = parseSleepPreventionPolicy(policy)
    this.#policy = next
    writeSleepPreventionPolicy(next, this.#preferencePath)
    this.#restartAttempts = 0
    this.#clearReleaseTimer()
    this.#clearRestartTimer()
    this.#queueReconcile({ immediate: true })
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    this.#clearReleaseTimer()
    this.#clearRestartTimer()
    for (const unsubscribe of this.#unsubscribers) unsubscribe()
    this.#unsubscribers = []
    this.#listeners.clear()
    await this.#releaseHeld()
  }

  #queueReconcile(options: { immediate?: boolean } = {}): void {
    if (this.#disposed) return
    const generation = ++this.#generation
    this.#reconcileChain = this.#reconcileChain.then(() => this.#reconcile(generation, options), () => this.#reconcile(generation, options))
  }

  async #reconcile(generation: number, options: { immediate?: boolean }): Promise<void> {
    if (this.#disposed || generation !== this.#generation) return
    const working = this.#working()
    const desired = shouldInhibitSleep(this.#policy.when, working)
    const keepDisplayAwake = this.#policy.keepDisplayAwake && this.#backend.displaySupported

    if (!this.#backend.supported) {
      this.#clearReleaseTimer()
      if (this.#held) await this.#releaseHeld()
      this.#snapshot = this.#buildSnapshot('unsupported', working)
      this.#emit()
      return
    }

    if (!desired) {
      if (!this.#held) {
        this.#snapshot = this.#buildSnapshot('idle', working)
        this.#emit()
        return
      }
      if (options.immediate || this.#releaseDebounceMs <= 0) {
        this.#clearReleaseTimer()
        await this.#releaseHeld()
        if (generation !== this.#generation || this.#disposed) return
        this.#snapshot = this.#buildSnapshot('idle', this.#working())
        this.#emit()
        return
      }
      if (!this.#releaseTimer) {
        this.#releaseTimer = setTimeout(() => {
          this.#releaseTimer = undefined
          this.#queueReconcile({ immediate: true })
        }, this.#releaseDebounceMs)
        this.#releaseTimer.unref?.()
      }
      this.#snapshot = this.#buildSnapshot('active', working)
      this.#emit()
      return
    }

    this.#clearReleaseTimer()
    if (this.#held && this.#heldDisplay === keepDisplayAwake) {
      this.#restartAttempts = 0
      this.#snapshot = this.#buildSnapshot('active', working)
      this.#emit()
      return
    }

    if (this.#held) await this.#releaseHeld()
    if (generation !== this.#generation || this.#disposed) return
    try {
      const held = await this.#backend.acquire({ keepDisplayAwake })
      if (generation !== this.#generation || this.#disposed) {
        await held.release()
        return
      }
      this.#held = held
      this.#heldDisplay = keepDisplayAwake
      this.#restartAttempts = 0
      this.#stopHeld = held.onUnexpectedExit(() => {
        if (this.#disposed || this.#held !== held) return
        this.#held = undefined
        this.#stopHeld = undefined
        this.#scheduleRestart()
      })
      this.#snapshot = this.#buildSnapshot('active', this.#working())
      this.#emit()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.#snapshot = this.#buildSnapshot('error', this.#working(), message)
      this.#emit()
      this.#scheduleRestart()
    }
  }

  #working(): boolean {
    const state = this.#sources.controller.getSnapshot()
    return hostWorkIsRunning({
      isStreaming: state.session.isStreaming,
      activity: state.activity,
      liveTools: state.liveTools,
      dispatching: Boolean(state.queue.dispatchingId),
      browserTaskStatus: this.#sources.browserIntegrations?.getSnapshot().task?.status ?? null,
    })
  }

  #buildSnapshot(status: SleepPreventionSnapshot['status'], working: boolean, error?: string): SleepPreventionSnapshot {
    const inhibiting = Boolean(this.#held) && status === 'active'
    return {
      policy: this.#policy,
      status,
      inhibiting,
      displaySupported: this.#backend.displaySupported,
      platform: this.#backend.platform,
      backend: this.#backend.name,
      reason: snapshotReason(status, this.#policy.when, working, inhibiting, this.#backend.displaySupported && this.#policy.keepDisplayAwake),
      limits: this.#backend.limits,
      ...(error ? { error } : {}),
    }
  }

  async #releaseHeld(): Promise<void> {
    const held = this.#held
    this.#held = undefined
    this.#stopHeld?.()
    this.#stopHeld = undefined
    if (held) await held.release().catch(() => undefined)
  }

  #scheduleRestart(): void {
    if (this.#disposed || this.#restartTimer) return
    const delay = RESTART_BACKOFF_MS[Math.min(this.#restartAttempts, RESTART_BACKOFF_MS.length - 1)] ?? 8_000
    this.#restartAttempts += 1
    if (this.#restartAttempts > RESTART_BACKOFF_MS.length) return
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      this.#queueReconcile({ immediate: true })
    }, delay)
    this.#restartTimer.unref?.()
  }

  #clearReleaseTimer(): void {
    if (!this.#releaseTimer) return
    clearTimeout(this.#releaseTimer)
    this.#releaseTimer = undefined
  }

  #clearRestartTimer(): void {
    if (!this.#restartTimer) return
    clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

function snapshotReason(
  status: SleepPreventionSnapshot['status'],
  when: SleepPreventionPolicy['when'],
  working: boolean,
  inhibiting: boolean,
  display: boolean,
): string {
  if (status === 'unsupported') return 'No supported idle-sleep inhibitor on this computer.'
  if (status === 'error') return 'The idle-sleep inhibitor failed. Heddlework did not claim the machine is protected.'
  if (when === 'off') return 'Idle sleep is allowed, including during agent work.'
  if (inhibiting) return display ? 'This computer will not idle-sleep, and the display stays awake.' : 'This computer will not idle-sleep. The display may still sleep.'
  if (when === 'whileAppOpen') return 'Idle sleep will be blocked while Heddlework stays open.'
  return working ? 'Work is running; waiting to hold idle sleep.' : 'Idle sleep is allowed until agent, tool, flow, or browser work starts.'
}
