import { readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createBrowserIntegrationService } from '../browser/integrations.ts'
import { createSleepPreventionPlugin, sleepPreventionToken } from '../power/plugin.ts'
import { createTerminalPlugin, terminalSessionToken } from '../terminal/plugin.ts'
import { themePreferencePath } from '../ui/theme-manager.ts'
import { currentAppVersion } from '../updates/version.ts'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import { runtimeDirectory, writePrivateJson, type RuntimeDescriptor } from '../runtime/paths.ts'
import { tryProcessLock } from '../runtime/process-lock.ts'
import { createRuntimeControlServer } from '../runtime/control-server.ts'
import { createRuntimeSettingsCoordinator } from '../runtime/settings-coordinator.ts'
import { createWorkspaceHost, remoteConnectUrls, hostConnectUrl } from './server.ts'
import { hostOptionsFromEnvironment } from './plugin.ts'
import { hostTokenPath, loadOrCreateHostToken } from './token.ts'
import { hostIdentityPath, loadOrCreateHostIdentity } from './identity.ts'
import { RemoteAccessService } from './remote-access.ts'
import { TailnetServeService } from './tailnet-serve.ts'
import { resolveStaticRoot } from './static-root.ts'
import { createRuntimeSessionFactory } from './runtime-composition.ts'
import { SessionRuntime } from './session-runtime.ts'

const directory = runtimeDirectory()
const release = tryProcessLock(join(directory, 'runtime.lock'))
if (!release) throw new Error('The Heddlework runtime is already running')
process.once('exit', release)
const workspacePath = resolve(process.env.HEDDLEWORK_CWD ?? process.argv.slice(2).find(value => value !== '--' && !value.startsWith('-')) ?? process.cwd())
const demo = process.env.HEDDLEWORK_DEMO === '1'
const isolated = demo || process.env.HEDDLEWORK_RUNTIME_TEST === '1'
const preferencePath = isolated ? false : themePreferencePath()
const token = loadOrCreateHostToken(isolated ? join(directory, 'host-token') : hostTokenPath())
const identity = loadOrCreateHostIdentity({ path: isolated ? false : hostIdentityPath() })
const createSession = createRuntimeSessionFactory(directory, demo)
const initial = await createSession({ workspacePath, id: 'default', ...(process.env.HEDDLEWORK_SESSION ? { sessionPath: process.env.HEDDLEWORK_SESSION } : {}) })
const runtime = new SessionRuntime({ initial, createSession, path: join(directory, 'registry.json') })
const browserIntegrations = createBrowserIntegrationService()
initial.kernel.mount(createSleepPreventionPlugin({ browserIntegrations, preferencePath }))
initial.kernel.mount(createTerminalPlugin({ cwd: workspacePath, ...(isolated ? { appearancePath: false as const, backend: 'memory' as const } : {}) }))
const sleepPrevention = initial.kernel.get(sleepPreventionToken)
const terminals = initial.kernel.get(terminalSessionToken)
const hostOptions = hostOptionsFromEnvironment(process.env, preferencePath)
let tailnet: TailnetServeService | undefined
const common = {
  controller: initial.controller,
  flows: initial.flows,
  runtime,
  workspacePath,
  token,
  identity,
  browserIntegrations,
  sleepPrevention,
  terminals,
  staticRoot: resolveStaticRoot(),
  extraHostUrls: () => tailnet?.advertisedHostUrls() ?? [],
}
// Native attachment always has a private loopback endpoint. Turning remote access off
// must not disconnect the desktop or terminate agents.
const local = createWorkspaceHost({ ...common, port: 0, hostname: '127.0.0.1' })
const remoteAccess = new RemoteAccessService({
  initialMode: hostOptions.enabled ? (hostOptions.hostname === '0.0.0.0' || hostOptions.hostname === '::' ? 'network' : 'local') : 'off',
  preferencePath,
  lockedBy: hostOptions.lockedBy,
  start: mode => createWorkspaceHost({ ...common, port: hostOptions.port, hostname: mode === 'network' ? '0.0.0.0' : '127.0.0.1' }),
})
tailnet = new TailnetServeService({ preferencePath, getHost: () => remoteAccess.host })
const unsubscribeRemote = remoteAccess.subscribe(() => { if (!remoteAccess.getSnapshot().busy) void tailnet?.reconcile() })
const settings = createRuntimeSettingsCoordinator({ workspacePath, remoteAccess, tailnet })
const instanceId = crypto.randomUUID()
let shuttingDown = false
const isBusy = () => runtime.isBusy() || terminals.getSnapshot().sessions.some(session => session.status.kind === 'running')
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  unsubscribeRemote()
  await local.close()
  await remoteAccess.close()
  await tailnet?.dispose()
  browserIntegrations.dispose()
  await runtime.dispose()
  await control.close()
  try {
    const saved = JSON.parse(readFileSync(join(directory, 'connection.json'), 'utf8')) as RuntimeDescriptor
    if (saved.instanceId === instanceId) unlinkSync(join(directory, 'connection.json'))
  } catch {}
  release()
}
const exit = (): void => { void shutdown().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) }
const control = createRuntimeControlServer({
  token, instanceId, protocol: PROTOCOL_VERSION, version: currentAppVersion(), isBusy,
  ...settings,
  upgrade: async () => {
    if (isBusy()) throw new Error('Agents or terminals are still running. The runtime update will wait.')
    setTimeout(exit, 100)
  },
  stop: async () => { setTimeout(exit, 100) },
})
process.once('SIGINT', exit)
process.once('SIGTERM', exit)
writePrivateJson(join(directory, 'connection.json'), {
  pid: process.pid, instanceId, protocol: PROTOCOL_VERSION, version: currentAppVersion(), executable: process.execPath,
  url: local.url, controlUrl: control.url, token, workspacePath,
  supervisor: process.env.HEDDLEWORK_RUNTIME_SUPERVISOR === 'launchd' ? 'launchd' : 'process',
} satisfies RuntimeDescriptor)
console.log(`Heddlework background runtime ${process.pid} serving ${workspacePath}`)
console.log(`  local ${hostConnectUrl(local)}`)
if (remoteAccess.host) for (const address of remoteConnectUrls(remoteAccess.host)) console.log(`  ${address.kind} ${address.url}`)
void initial.controller.start()
