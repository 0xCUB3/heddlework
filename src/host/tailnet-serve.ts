import type { WorkspaceHost } from './server.ts'
import {
  createTailscaleCli,
  redactSecrets,
  type ServeConfig,
  type TailscaleCli,
  type TailscaleHttpsPort,
  type TailscaleNodeStatus,
} from './tailscale-cli.ts'
import {
  inspectTailnetServe,
  ownedEndpoint,
  ownershipMatches,
  readTailnetServePreference,
  tailnetHostUrl,
  writeTailnetServePreference,
  type TailnetServePreference,
  type TailnetServeSnapshot,
} from './tailscale-serve.ts'

interface TailnetReadState {
  binaryPath?: string
  status?: TailscaleNodeStatus
  config?: ServeConfig
}

export interface TailnetServeOptions {
  preferencePath: string | false
  getHost(): WorkspaceHost | undefined
  cli?: TailscaleCli
  verify?: (url: string) => Promise<void>
}

export class TailnetServeService {
  readonly #preferencePath: string | false
  readonly #getHost: () => WorkspaceHost | undefined
  readonly #cli: TailscaleCli
  readonly #verify: (url: string) => Promise<void>
  readonly #listeners = new Set<() => void>()
  #preference: TailnetServePreference
  #snapshot: TailnetServeSnapshot
  #transition: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(options: TailnetServeOptions) {
    this.#preferencePath = options.preferencePath
    this.#getHost = options.getHost
    this.#cli = options.cli ?? createTailscaleCli()
    this.#verify = options.verify ?? verifyServeHttps
    this.#preference = readTailnetServePreference(options.preferencePath)
    this.#snapshot = inspectTailnetServe({ preference: this.#preference, hostPort: options.getHost()?.port })
    if (this.#preference.enabled) this.#queue(() => this.#reconcile())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  getSnapshot = (): TailnetServeSnapshot => this.#snapshot

  advertisedHostUrls(): string[] {
    return this.#snapshot.status === 'ready' && this.#snapshot.url ? [this.#snapshot.url] : []
  }

  async refresh(): Promise<void> {
    await this.#queue(() => this.#inspect())
  }

  async reconcile(): Promise<void> {
    await this.#queue(() => this.#preference.enabled ? this.#reconcile() : this.#inspect())
  }

  async idle(): Promise<void> {
    await this.#transition.catch(() => undefined)
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.#queue(async () => {
      this.#preference = { ...this.#preference, enabled }
      this.#persist()
      if (enabled) await this.#reconcile()
      else await this.#stopOwned(true)
    })
  }

  async setHttpsPort(port: TailscaleHttpsPort): Promise<void> {
    await this.#queue(async () => {
      this.#preference = { ...this.#preference, httpsPort: port }
      this.#persist()
      if (this.#preference.enabled) await this.#reconcile()
      else await this.#inspect()
    })
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await this.#transition.catch(() => undefined)
    this.#listeners.clear()
  }

  #queue(run: () => Promise<unknown>): Promise<void> {
    const wrapped = async (): Promise<void> => {
      if (this.#disposed) return
      await run()
    }
    this.#transition = this.#transition.then(wrapped, wrapped)
    return this.#transition
  }

  #persist(): void {
    writeTailnetServePreference(this.#preference, this.#preferencePath)
  }

  #set(snapshot: TailnetServeSnapshot): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  async #inspect(): Promise<TailnetReadState> {
    const state = await this.#readState()
    this.#set(inspectTailnetServe({
      preference: this.#preference,
      hostPort: this.#getHost()?.port,
      ...state,
    }))
    return state
  }

  async #readState(): Promise<TailnetReadState> {
    const binaryPath = this.#cli.findBinary()
    if (!binaryPath) return {}
    try {
      const [status, config] = await Promise.all([this.#cli.status(binaryPath), this.#cli.serveStatus(binaryPath)])
      return { binaryPath, status, config }
    } catch (cause) {
      this.#set(inspectTailnetServe({
        binaryPath,
        preference: this.#preference,
        hostPort: this.#getHost()?.port,
        error: cause instanceof Error ? redactSecrets(cause.message) : String(cause),
      }))
      throw cause
    }
  }

  async #reconcile(): Promise<void> {
    const host = this.#getHost()
    this.#set(inspectTailnetServe({ preference: this.#preference, hostPort: host?.port, busy: true, phase: 'starting' }))
    let state: TailnetReadState
    try {
      state = await this.#readState()
    } catch {
      return
    }
    const inspected = inspectTailnetServe({ preference: this.#preference, hostPort: host?.port, ...state })
    if (inspected.status !== 'idle' && inspected.status !== 'ready' && inspected.status !== 'needsHost') {
      this.#set(inspected)
      return
    }
    if (!host) {
      await this.#stopOwned(false)
      this.#set({ ...inspected, status: 'needsHost', message: 'Turn on Remote access so Tailscale Serve has a local workbench to proxy.', busy: false })
      return
    }
    if (!state.binaryPath || !state.status || !inspected.dnsName || inspected.httpsPort === undefined) {
      this.#set(inspected)
      return
    }
    const ownership = ownedEndpoint(inspected.dnsName, inspected.httpsPort, host.port)
    const already = state.config ? ownershipMatches(state.config, ownership) : false
    try {
      if (!already) {
        const previous = this.#preference.ownership
        await this.#cli.serveHttps(state.binaryPath, ownership.httpsPort, ownership.proxy)
        if (previous && (previous.httpsPort !== ownership.httpsPort || previous.dnsName !== ownership.dnsName)) {
          const still = await this.#cli.serveStatus(state.binaryPath)
          if (ownershipMatches(still, previous)) await this.#cli.serveHttpsOff(state.binaryPath, previous.httpsPort)
        }
      }
      const config = await this.#cli.serveStatus(state.binaryPath)
      if (!ownershipMatches(config, ownership)) {
        this.#preference = { ...this.#preference, enabled: true }
        this.#persist()
        this.#set(inspectTailnetServe({
          ...state,
          config,
          preference: this.#preference,
          hostPort: host.port,
          error: 'Tailscale Serve did not keep the Heddlework endpoint. Existing endpoints were left alone.',
        }))
        return
      }
      await this.#verify(tailnetHostUrl(ownership.dnsName, ownership.httpsPort))
      this.#preference = { ...this.#preference, enabled: true, ownership }
      this.#persist()
      this.#set(inspectTailnetServe({
        ...state,
        config,
        preference: this.#preference,
        hostPort: host.port,
      }))
    } catch (cause) {
      const message = cause instanceof Error ? redactSecrets(cause.message) : String(cause)
      this.#preference = { ...this.#preference, enabled: true, ownership }
      this.#persist()
      let config = state.config
      try { config = await this.#cli.serveStatus(state.binaryPath) } catch { /* keep last */ }
      this.#set(inspectTailnetServe({
        ...state,
        ...(config ? { config } : {}),
        preference: this.#preference,
        hostPort: host.port,
        error: /certificate|cert|tls|https/i.test(message)
          ? `Tailscale Serve is configured, but HTTPS is not ready yet. ${message}`
          : message,
      }))
    }
  }

  async #stopOwned(clearIntent: boolean): Promise<void> {
    if (clearIntent) {
      this.#set(inspectTailnetServe({ preference: this.#preference, hostPort: this.#getHost()?.port, busy: true, phase: 'stopping' }))
    }
    const ownership = this.#preference.ownership
    const binaryPath = this.#cli.findBinary()
    if (ownership && binaryPath) {
      try {
        const config = await this.#cli.serveStatus(binaryPath)
        if (ownershipMatches(config, ownership)) {
          await this.#cli.serveHttpsOff(binaryPath, ownership.httpsPort)
        }
      } catch (cause) {
        const message = cause instanceof Error ? redactSecrets(cause.message) : String(cause)
        if (!/handler does not exist/i.test(message)) {
          if (clearIntent) {
            this.#preference = { ...this.#preference, enabled: false }
            this.#persist()
          }
          this.#set(inspectTailnetServe({
            binaryPath,
            preference: this.#preference,
            hostPort: this.#getHost()?.port,
            error: message,
          }))
          return
        }
      }
    }
    const httpsPort = this.#preference.httpsPort
    this.#preference = clearIntent
      ? { enabled: false, ...(httpsPort ? { httpsPort } : {}) }
      : { ...this.#preference, enabled: true, ...(httpsPort ? { httpsPort } : {}) }
    if (clearIntent) {
      this.#persist()
      try {
        await this.#inspect()
      } catch {
        this.#set(inspectTailnetServe({ preference: this.#preference, hostPort: this.#getHost()?.port }))
      }
    } else {
      this.#persist()
    }
  }
}

export async function verifyServeHttps(baseUrl: string): Promise<void> {
  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(8_000) })
  if (!health.ok) throw new Error(`Tailnet HTTPS health check failed (${health.status}).`)
  const socket = await fetch(`${baseUrl}/ws`, { signal: AbortSignal.timeout(8_000) })
  if (socket.status !== 401 && socket.status !== 426) {
    throw new Error(`Tailnet HTTPS proxy did not reach the workbench auth check (status ${socket.status}).`)
  }
}
