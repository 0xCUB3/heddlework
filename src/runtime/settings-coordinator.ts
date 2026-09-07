import type { RemoteAccessService } from '../host/remote-access.ts'
import type { TailnetServeService } from '../host/tailnet-serve.ts'
import { remoteConnectUrls, type WorkspaceHost } from '../host/server.ts'
import type { RuntimeHostSnapshot, RuntimeSettingsRequest, RuntimeSettingsStatus } from './control-protocol.ts'

export interface RuntimeSettingsCoordinatorOptions {
  workspacePath: string
  remoteAccess: RemoteAccessService
  tailnet: TailnetServeService
}

function hostSnapshot(host: WorkspaceHost): RuntimeHostSnapshot {
  return {
    url: host.url,
    port: host.port,
    hostname: host.hostname,
    token: host.token,
    workspacePath: host.workspacePath,
  }
}

export function createRuntimeSettingsCoordinator(options: RuntimeSettingsCoordinatorOptions) {
  const settingsStatus = (): RuntimeSettingsStatus => {
    const remote = options.remoteAccess.getSnapshot()
    const host = remote.host
    return {
      workspacePath: options.workspacePath,
      remote: {
        mode: remote.mode,
        busy: remote.busy,
        ...(remote.lockedBy ? { lockedBy: remote.lockedBy } : {}),
        ...(remote.error ? { error: remote.error } : {}),
        ...(host ? { host: hostSnapshot(host) } : {}),
      },
      tailnet: options.tailnet.getSnapshot(),
      remotes: host ? remoteConnectUrls(host) : [],
    }
  }

  const applySettings = async (request: RuntimeSettingsRequest): Promise<RuntimeSettingsStatus> => {
    switch (request.op) {
      case 'setRemoteAccessMode':
        await options.remoteAccess.setMode(request.mode)
        break
      case 'setTailnetEnabled':
        await options.tailnet.setEnabled(request.enabled)
        break
      case 'setTailnetHttpsPort':
        await options.tailnet.setHttpsPort(request.port)
        break
      case 'refreshTailnet':
        await options.tailnet.refresh()
        break
    }
    return settingsStatus()
  }

  return { settingsStatus, applySettings }
}

