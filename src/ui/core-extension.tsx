import React, { useSyncExternalStore } from 'react'
import type { WorkbenchPlugin } from '../core/kernel.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { DiffPanel } from './diff-panel.tsx'
import {
  workbenchUiRegistryToken,
  type WorkbenchSurfaceContribution,
  type WorkbenchSurfaceProps,
  type WorkbenchUiExtension,
} from './extensions.ts'
import type { IconName } from './icons.tsx'
import { SurfacePlaceholderPanel } from './surface-picker.tsx'

export function createCoreUiExtensionPlugin(): WorkbenchPlugin {
  return {
    id: 'core-workbench-ui',
    requires: [workbenchUiRegistryToken, workbenchControllerToken],
    activate(ctx) {
      const registry = ctx.get(workbenchUiRegistryToken)
      const controller = ctx.get(workbenchControllerToken)
      ctx.effect(() => registry.register(createCoreUiExtension(controller)))
    },
  }
}

export function createCoreUiExtension(controller: WorkbenchController): WorkbenchUiExtension {
  function DiffSurface(props: WorkbenchSurfaceProps) {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    return (
      <DiffPanel
        diff={state.workspaceDiff}
        controller={controller}
        fullscreen={props.fullscreen}
        fullscreenProgress={props.fullscreenProgress}
        panelWidth={props.panelWidth}
        {...(props.appearance ? { appearance: props.appearance } : {})}
        onToggleFullscreen={props.onToggleFullscreen}
        onNewSurface={props.onNewSurface}
        onClose={props.onClose}
      />
    )
  }

  return {
    id: 'heddlework.core',
    surfaces: [
      placeholder('browser', 'Browser', 'Open a local app or URL.', 'globe', 10),
      placeholder('terminal', 'Terminal', 'Start a shell in this workspace.', 'terminal', 20),
      placeholder('files', 'Files', 'Browse and read workspace files.', 'files', 30),
      {
        id: 'diff',
        title: 'Diff',
        description: 'Review working-tree changes.',
        icon: 'fileDiff',
        order: 40,
        component: DiffSurface,
        onOpen: () => { void controller.refreshWorkspaceDiff() },
      },
      placeholder('agents', 'Agents', 'Watch subagents and workflows run.', 'bot', 50),
    ],
  }
}

function placeholder(id: string, title: string, description: string, icon: IconName, order: number): WorkbenchSurfaceContribution {
  function PlaceholderSurface(props: WorkbenchSurfaceProps) {
    return (
      <SurfacePlaceholderPanel
        descriptor={{ id, title, description, icon }}
        fullscreen={props.fullscreen}
        fullscreenProgress={props.fullscreenProgress}
        panelWidth={props.panelWidth}
        onToggleFullscreen={props.onToggleFullscreen}
        onNew={props.onNewSurface}
        onClose={props.onClose}
      />
    )
  }

  return { id, title, description, icon, order, component: PlaceholderSurface }
}
