import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyServeConfig,
  findTailscaleBinary,
  parseNodeStatus,
  parseServeConfig,
  redactSecrets,
  type ServeConfig,
  type TailscaleCli,
  type TailscaleHttpsPort,
  type TailscaleNodeStatus,
} from '../src/host/tailscale-cli.ts'
import {
  chooseHttpsPort,
  inspectTailnetServe,
  localProxyUrl,
  ownedEndpoint,
  ownershipMatches,
  parseTailnetServePreference,
  readTailnetServePreference,
  tailnetConnectUrl,
  tailnetHostUrl,
  writeTailnetServePreference,
} from '../src/host/tailscale-serve.ts'
import { TailnetServeService } from '../src/host/tailnet-serve.ts'
import { preferredPairingLink, withConnectToken } from '../src/host/server.ts'

const DNS = 'macbook-pro-m4.tail8b9c7.ts.net'

function node(overrides: Partial<TailscaleNodeStatus> = {}): TailscaleNodeStatus {
  return {
    backendState: 'Running',
    httpsCapability: true,
    certDomains: [DNS],
    magicDnsEnabled: true,
    online: true,
    health: [],
    dnsName: DNS,
    ...overrides,
  }
}

function occupied443(): ServeConfig {
  return {
    tcp: { '443': { https: true } },
    web: { [`${DNS}:443`]: { handlers: { '/': { proxy: 'http://127.0.0.1:30141' } } } },
    allowFunnel: {},
  }
}

class FakeCli implements TailscaleCli {
  binary: string | undefined = '/opt/homebrew/bin/tailscale'
  nodeStatus: TailscaleNodeStatus = node()
  config: ServeConfig = occupied443()
  commands: string[][] = []
  failOff = false

  findBinary = (): string | undefined => this.binary
  status = async (): Promise<TailscaleNodeStatus> => this.nodeStatus
  serveStatus = async (): Promise<ServeConfig> => structuredClone(this.config)
  serveHttps = async (_binary: string, port: TailscaleHttpsPort, target: string): Promise<string> => {
    this.commands.push(['serve', String(port), target])
    this.config.tcp[String(port)] = { https: true }
    this.config.web[`${DNS}:${port}`] = { handlers: { '/': { proxy: target } } }
    return `https://${DNS}:${port}/`
  }
  serveHttpsOff = async (_binary: string, port: TailscaleHttpsPort): Promise<void> => {
    this.commands.push(['off', String(port)])
    if (this.failOff) throw new Error('handler does not exist')
    delete this.config.tcp[String(port)]
    delete this.config.web[`${DNS}:${port}`]
  }
}

function fakeHost(port = 4817) {
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hostname: '127.0.0.1',
    token: 'tok_secret',
    workspacePath: '/w',
    connectionCount: () => 0,
    close: async () => undefined,
  }
}

describe('tailscale serve parsing', () => {
  it('reads daemon login, HTTPS capability, and Serve handlers without keeping peers', () => {
    const status = parseNodeStatus(JSON.stringify({
      BackendState: 'Running',
      AuthURL: '',
      CertDomains: [`${DNS}.`],
      CurrentTailnet: { Name: 'example', MagicDNSEnabled: true, MagicDNSSuffix: 'tail8b9c7.ts.net' },
      Self: { DNSName: `${DNS}.`, Online: true, CapMap: { https: {}, funnel: {} } },
      Peer: { 'should-not-matter': { HostName: 'other' } },
    }))
    expect(status.dnsName).toBe(DNS)
    expect(status.httpsCapability).toBe(true)
    expect(status.magicDnsEnabled).toBe(true)
    expect(JSON.stringify(status)).not.toContain('other')

    const serve = parseServeConfig(JSON.stringify({
      TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } },
      Web: {
        [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:30141' } } },
        [`${DNS}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4817' } } },
      },
    }))
    expect(serve.web[`${DNS}:443`]?.handlers['/']?.proxy).toBe('http://127.0.0.1:30141')
    expect(parseServeConfig('No serve config')).toEqual(emptyServeConfig())
  })

  it('redacts tokens and finds an override binary only when it exists', () => {
    expect(redactSecrets('https://host.ts.net:8443/?token=abc123&x=1')).toBe('https://host.ts.net:8443/?token=***&x=1')
    expect(findTailscaleBinary({ HEDDLEWORK_TAILSCALE: '/nope/tailscale', PATH: '' }, () => false)).toBeUndefined()
    expect(findTailscaleBinary({ HEDDLEWORK_TAILSCALE: '/opt/homebrew/bin/tailscale', PATH: '' }, (path) => path === '/opt/homebrew/bin/tailscale')).toBe('/opt/homebrew/bin/tailscale')
  })
})

describe('tailscale serve ownership', () => {
  it('skips 443 when another app owns it and will not match a foreign handler', () => {
    const config = occupied443()
    const choice = chooseHttpsPort({ config, dnsName: DNS })
    expect('port' in choice && choice.port).toBe(8443)
    expect(choice.conflicts[0]?.port).toBe(443)
    expect(ownershipMatches(config, ownedEndpoint(DNS, 443, 4817))).toBe(false)
    expect(ownershipMatches({
      tcp: { '8443': { https: true } },
      web: { [`${DNS}:8443`]: { handlers: { '/': { proxy: localProxyUrl(4817) } } } },
      allowFunnel: {},
    }, ownedEndpoint(DNS, 8443, 4817))).toBe(true)
  })

  it('refuses a preferred port that is taken instead of silently switching', () => {
    const choice = chooseHttpsPort({ config: occupied443(), dnsName: DNS, preferred: 443 })
    expect('port' in choice).toBe(false)
    expect(choice.available).toEqual([8443, 10_000])
  })

  it('omits :443 from the MagicDNS URL and keeps the token in the query', () => {
    expect(tailnetHostUrl(DNS, 443)).toBe(`https://${DNS}`)
    expect(tailnetHostUrl(`${DNS}.`, 8443)).toBe(`https://${DNS}:8443`)
    expect(tailnetConnectUrl(DNS, 8443, 'a b')).toBe(`https://${DNS}:8443/?token=a%20b`)
    expect(preferredPairingLink(fakeHost(), `https://${DNS}:8443`)).toBe(`https://${DNS}:8443/?token=tok_secret`)
    expect(withConnectToken('https://host/', 'x')).toBe('https://host/?token=x')
  })
})

describe('tailnet serve inspect', () => {
  it('reports missing binary, signed-out daemon, and missing HTTPS certs', () => {
    expect(inspectTailnetServe({ preference: { enabled: false } }).status).toBe('notInstalled')
    expect(inspectTailnetServe({ binaryPath: '/ts', status: node({ backendState: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a' }), preference: { enabled: false } }).status).toBe('needsLogin')
    expect(inspectTailnetServe({
      binaryPath: '/ts',
      status: node({ httpsCapability: false, certDomains: [] }),
      preference: { enabled: false },
    }).status).toBe('needsHttps')
  })

  it('keeps ready only when the live handler still matches ownership', () => {
    const ownership = ownedEndpoint(DNS, 8443, 4817)
    const config: ServeConfig = {
      ...occupied443(),
      tcp: { ...occupied443().tcp, '8443': { https: true } },
      web: { ...occupied443().web, [`${DNS}:8443`]: { handlers: { '/': { proxy: ownership.proxy } } } },
    }
    const ready = inspectTailnetServe({
      binaryPath: '/ts',
      status: node(),
      config,
      preference: { enabled: true, ownership },
      hostPort: 4817,
    })
    expect(ready.status).toBe('ready')
    expect(ready.url).toBe(`https://${DNS}:8443`)
    const stolen = inspectTailnetServe({
      binaryPath: '/ts',
      status: node(),
      config: occupied443(),
      preference: { enabled: true, httpsPort: 443, ownership: ownedEndpoint(DNS, 443, 4817) },
      hostPort: 4817,
    })
    expect(stolen.status).toBe('conflict')
  })
})

describe('tailnet serve persistence and lifecycle', () => {
  it('merges preference into existing json and ignores junk', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hw-tailnet-')), 'preferences.json')
    writeFileSync(path, JSON.stringify({ themeMode: 'dark', remoteAccess: 'local' }))
    expect(parseTailnetServePreference({ enabled: 'yes', httpsPort: 80 })).toEqual({ enabled: false })
    writeTailnetServePreference({ enabled: true, httpsPort: 8443, ownership: ownedEndpoint(DNS, 8443, 4817) }, path)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(stored.themeMode).toBe('dark')
    expect(stored.remoteAccess).toBe('local')
    expect(readTailnetServePreference(path)).toEqual({ enabled: true, httpsPort: 8443, ownership: ownedEndpoint(DNS, 8443, 4817) })
  })

  it('sets up 8443 when 443 is taken, verifies, then stops only the owned rule', async () => {
    const cli = new FakeCli()
    let host: ReturnType<typeof fakeHost> | undefined = fakeHost(4817)
    const verified: string[] = []
    const service = new TailnetServeService({
      preferencePath: false,
      getHost: () => host,
      cli,
      verify: async (url) => { verified.push(url) },
    })
    await service.refresh()
    expect(service.getSnapshot().status).toBe('idle')
    expect(service.getSnapshot().httpsPort).toBe(8443)
    await service.setEnabled(true)
    expect(cli.commands).toEqual([['serve', '8443', 'http://127.0.0.1:4817']])
    expect(verified).toEqual([`https://${DNS}:8443`])
    expect(service.getSnapshot().status).toBe('ready')
    expect(service.advertisedHostUrls()).toEqual([`https://${DNS}:8443`])
    expect(cli.config.web[`${DNS}:443`]?.handlers['/']?.proxy).toBe('http://127.0.0.1:30141')

    await service.setEnabled(false)
    expect(cli.commands.at(-1)).toEqual(['off', '8443'])
    expect(cli.config.web[`${DNS}:443`]?.handlers['/']?.proxy).toBe('http://127.0.0.1:30141')
    expect(cli.config.web[`${DNS}:8443`]).toBeUndefined()
    expect(service.getSnapshot().enabled).toBe(false)
    expect(service.advertisedHostUrls()).toEqual([])
    await service.dispose()
    void host
  })

  it('does not clobber a foreign handler and does not stop after an external change', async () => {
    const cli = new FakeCli()
    const service = new TailnetServeService({
      preferencePath: false,
      getHost: () => fakeHost(),
      cli,
      verify: async () => undefined,
    })
    await service.setHttpsPort(443)
    await service.setEnabled(true)
    expect(cli.commands).toEqual([])
    expect(service.getSnapshot().status).toBe('conflict')
    expect(cli.config.web[`${DNS}:443`]?.handlers['/']?.proxy).toBe('http://127.0.0.1:30141')

    cli.config = {
      tcp: { '443': { https: true }, '8443': { https: true } },
      web: {
        [`${DNS}:443`]: { handlers: { '/': { proxy: 'http://127.0.0.1:30141' } } },
        [`${DNS}:8443`]: { handlers: { '/': { proxy: 'http://127.0.0.1:9' } } },
      },
      allowFunnel: {},
    }
    await service.setHttpsPort(8443)
    await service.setEnabled(true)
    expect(service.getSnapshot().status).toBe('conflict')
    expect(cli.commands).toEqual([])
    await service.setEnabled(false)
    expect(cli.commands).toEqual([])
    expect(cli.config.web[`${DNS}:8443`]?.handlers['/']?.proxy).toBe('http://127.0.0.1:9')
    await service.dispose()
  })

  it('queues concurrent enable/disable and redacts tokens in errors', async () => {
    const cli = new FakeCli()
    const service = new TailnetServeService({
      preferencePath: false,
      getHost: () => fakeHost(),
      cli,
      verify: async () => { throw new Error('bad https://host/?token=abc123') },
    })
    const first = service.setEnabled(true)
    const second = service.setEnabled(false)
    await first
    await second
    expect(service.getSnapshot().error ?? '').not.toContain('abc123')
    expect(service.getSnapshot().enabled).toBe(false)
    await service.dispose()
  })

  it('stays needsHost when the workbench is off, and missing CLI is notInstalled', async () => {
    const cli = new FakeCli()
    cli.binary = undefined
    const none = new TailnetServeService({ preferencePath: false, getHost: () => fakeHost(), cli, verify: async () => undefined })
    await none.refresh()
    expect(none.getSnapshot().status).toBe('notInstalled')
    await none.dispose()

    const present = new FakeCli()
    const waiting = new TailnetServeService({ preferencePath: false, getHost: () => undefined, cli: present, verify: async () => undefined })
    await waiting.setEnabled(true)
    expect(waiting.getSnapshot().status).toBe('needsHost')
    expect(present.commands).toEqual([])
    await waiting.dispose()
  })
})
