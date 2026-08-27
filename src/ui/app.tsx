import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { WorkbenchController } from '../workbench/controller.ts'
import { ChatHeader } from './chat-header.tsx'
import { Composer } from './composer.tsx'
import { NotificationLedgerView } from './notifications.tsx'
import { SettingsView } from './settings-view.tsx'
import { WorkbenchSidebar } from './sidebar.tsx'
import { SurfacePickerPanel } from './surface-picker.tsx'
import { Transcript } from './transcript.tsx'
import type { WorkbenchUiRegistry } from './extensions.ts'
import type { ToolPresenter } from './tool-presenters.ts'
import { Icon } from './icons.tsx'
import { colors } from './theme.ts'
import { defaultThemeManager, type ThemeManager } from './theme-manager.ts'
import { SPRING_SETTLE_MS, useSpringProgress } from './motion.ts'

type Surface = 'chat' | 'settings'
type RightPanel = 'notifications' | 'surfaces' | `surface:${string}`

const LEFT_SIDEBAR_WIDTH = 256

function surfacePanelId(surfaceId: string): `surface:${string}` {
  return `surface:${surfaceId}`
}

function workbenchSurfaceId(panel: RightPanel | undefined): string | undefined {
  return panel?.startsWith('surface:') ? panel.slice('surface:'.length) : undefined
}

export function WorkbenchApp({
  controller,
  presenters,
  ui,
  themeManager = defaultThemeManager,
}: {
  controller: WorkbenchController
  presenters: ReadonlyMap<string, ToolPresenter>
  ui: WorkbenchUiRegistry
  themeManager?: ThemeManager
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const theme = useSyncExternalStore(themeManager.subscribe, themeManager.getSnapshot)
  const uiSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
  const renderer = useGpuixRequired()
  const [surface, setSurface] = useState<Surface>('chat')
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true)
  const leftSidebarProgress = useSpringProgress(leftSidebarOpen)
  const [rightPanel, setRightPanel] = useState<RightPanel | undefined>()
  const [displayedRightPanel, setDisplayedRightPanel] = useState<RightPanel | undefined>()
  const rightPanelProgress = useSpringProgress(Boolean(rightPanel))
  const [panelFullscreen, setPanelFullscreen] = useState(false)
  const fullscreenProgress = Math.min(1, useSpringProgress(panelFullscreen))
  const diffOpen = rightPanel === surfacePanelId('diff')
  const notificationsOpen = rightPanel === 'notifications'
  const [lastSeenNoticeId, setLastSeenNoticeId] = useState(0)
  const latestNoticeId = state.notices.at(-1)?.id ?? 0
  const unreadCount = state.notices.filter((notice) => notice.id > lastSeenNoticeId).length
  const draft = state.messages.length === 0 && !state.liveAssistant && !state.session.isStreaming
  const projectName = state.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? state.workspacePath

  useEffect(() => {
    renderer.setWindowTitle?.(state.windowTitle)
  }, [renderer, state.windowTitle])

  useEffect(() => {
    if (notificationsOpen) setLastSeenNoticeId(latestNoticeId)
  }, [latestNoticeId, notificationsOpen])

  useEffect(() => {
    if (rightPanel) {
      setDisplayedRightPanel(rightPanel)
      return
    }
    setPanelFullscreen(false)
    const timer = setTimeout(() => setDisplayedRightPanel(undefined), SPRING_SETTLE_MS + 32)
    return () => clearTimeout(timer)
  }, [rightPanel])

  const closeRightPanel = () => {
    setRightPanel(undefined)
    setPanelFullscreen(false)
  }

  useEffect(() => {
    const surfaceId = workbenchSurfaceId(rightPanel)
    if (surfaceId && !uiSnapshot.surfaces.some((candidate) => candidate.id === surfaceId)) closeRightPanel()
  }, [rightPanel, uiSnapshot.surfaces])

  const returnToConversation = () => {
    setSurface('chat')
    closeRightPanel()
  }

  const toggleNotifications = () => {
    setSurface('chat')
    setPanelFullscreen(false)
    if (notificationsOpen) {
      setRightPanel(undefined)
      return
    }
    setLastSeenNoticeId(latestNoticeId)
    setDisplayedRightPanel('notifications')
    setRightPanel('notifications')
  }

  const openWorkbenchSurface = (surfaceId: string, preserveFullscreen = false) => {
    const contribution = uiSnapshot.surfaces.find((candidate) => candidate.id === surfaceId)
    if (!contribution) return
    contribution.onOpen?.()
    setSurface('chat')
    if (!preserveFullscreen) setPanelFullscreen(false)
    const panelId = surfacePanelId(surfaceId)
    setDisplayedRightPanel(panelId)
    setRightPanel(panelId)
  }

  const openDiff = (preserveFullscreen = false) => openWorkbenchSurface('diff', preserveFullscreen)

  const toggleDiff = () => {
    if (diffOpen) closeRightPanel()
    else openDiff()
  }

  const openSurfacePicker = () => {
    setSurface('chat')
    setDisplayedRightPanel('surfaces')
    setRightPanel('surfaces')
  }

  const selectSurface = (surfaceId: string) => openWorkbenchSurface(surfaceId, true)

  const togglePanelFullscreen = () => setPanelFullscreen((value) => !value)

  const shellWidth = renderer.getWindowSize?.().width ?? 1_200
  const mainWidth = shellWidth - LEFT_SIDEBAR_WIDTH * leftSidebarProgress
  const standardPanelWidth = Math.max(420, Math.floor(mainWidth * 0.44))
  const panelWidth = displayedRightPanel === 'notifications' ? 422 : standardPanelWidth
  const animatedSidebarProgress = leftSidebarProgress * (1 - fullscreenProgress)
  const fullscreenVisible = panelFullscreen || fullscreenProgress > 0.001
  const sidebarToggleLeft = process.platform === 'darwin' ? 90 : 10 + 54 * animatedSidebarProgress
  const displayedSurfaceId = workbenchSurfaceId(displayedRightPanel)
  const displayedSurface = uiSnapshot.surfaces.find((candidate) => candidate.id === displayedSurfaceId)
  const SurfaceComponent = displayedSurface?.component
  const panel = displayedRightPanel === 'notifications'
    ? <NotificationLedgerView state={state} panelWidth={panelWidth} onClear={() => controller.clearNotices()} />
    : displayedRightPanel === 'surfaces'
      ? <SurfacePickerPanel surfaces={uiSnapshot.surfaces} fullscreen={fullscreenVisible} fullscreenProgress={fullscreenProgress} panelWidth={panelWidth} onToggleFullscreen={togglePanelFullscreen} onSelect={selectSurface} onClose={closeRightPanel} />
      : SurfaceComponent
        ? <SurfaceComponent fullscreen={fullscreenVisible} fullscreenProgress={fullscreenProgress} panelWidth={panelWidth} appearance={theme.resolved} onToggleFullscreen={togglePanelFullscreen} onNewSurface={openSurfacePicker} onClose={closeRightPanel} />
        : null

  return (
    <div testId="workbench-root" style={{ position: 'relative', display: 'flex', flexDirection: 'row', width: '100%', height: '100%', backgroundColor: colors.background, color: colors.text, overflow: 'hidden' }}>
      <>
          <div testId="left-sidebar-host" style={{ position: 'relative', width: LEFT_SIDEBAR_WIDTH * animatedSidebarProgress, height: '100%', flexShrink: 0, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: LEFT_SIDEBAR_WIDTH }}>
              <WorkbenchSidebar
                state={state}
                controller={controller}
                settingsActive={surface === 'settings'}
                notificationsActive={notificationsOpen}
                unreadCount={unreadCount}
                appearance={theme.resolved}
                onSelectSession={returnToConversation}
                onSettings={() => {
                  closeRightPanel()
                  setSurface((current) => current === 'settings' ? 'chat' : 'settings')
                }}
                onNotifications={toggleNotifications}
              />
            </div>
          </div>
          {surface === 'settings' ? (
            <SettingsView state={state} controller={controller} theme={theme} onThemeModeChange={(mode) => themeManager.setMode(mode)} onClose={() => setSurface('chat')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, minWidth: 0, height: '100%', backgroundColor: colors.background }}>
              <div style={{ display: 'flex', flexDirection: 'column', width: 0, flexGrow: 1 - fullscreenProgress, minWidth: 0, height: '100%', overflow: 'hidden' }}>
                <ChatHeader state={state} controller={controller} diffOpen={diffOpen} leftSidebarProgress={animatedSidebarProgress} onToggleDiff={toggleDiff} />
                <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
                  {draft ? (
                    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 25, paddingLeft: 20, paddingRight: 20, paddingBottom: 74 }}>
                      <text style={{ color: colors.text, fontSize: 26, fontWeight: 500, maxWidth: 900, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`What should we build in ${projectName}?`}</text>
                      <Composer state={state} controller={controller} draft />
                    </div>
                  ) : (
                    <>
                      <Transcript state={state} presenters={presenters} onOpenDiff={() => openDiff()} onRevert={(entryId) => void controller.forkFrom(entryId)} onLoadEarlier={controller.loadEarlierMessages} />
                      <TranscriptFade />
                      <Composer state={state} controller={controller} />
                    </>
                  )}
                </div>
              </div>
              {panel && (
                <div testId="right-panel-host" style={{ position: 'relative', width: panelWidth * rightPanelProgress * (1 - fullscreenProgress), flexGrow: fullscreenProgress * rightPanelProgress, minWidth: 0, height: '100%', flexShrink: 0, overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>{panel}</div>
                </div>
              )}
            </div>
          )}
        </>
      {!panelFullscreen && (
        <div
          testId="toggle-left-sidebar"
          tabIndex={0}
          style={{ position: 'absolute', top: 12, left: sidebarToggleLeft, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.hover } }}
          onClick={() => setLeftSidebarOpen((value) => !value)}
        >
          <div style={{ width: 15, height: 15, pointerEvents: 'none' }}><Icon name={leftSidebarOpen ? 'panelLeftClose' : 'panelLeft'} size={15} color={colors.textMuted} /></div>
        </div>
      )}
    </div>
  )
}

function TranscriptFade() {
  const layers = ['08', '18', '2C', '45', '65', '88', 'AC', 'CE', 'E8', 'F8']
  return (
    <div testId="transcript-bottom-fade" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 240, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
      {layers.map((alpha) => (
        <React.Fragment key={alpha}>
          <div style={{ height: 24, flexShrink: 0, backgroundColor: `${colors.background}${alpha}` }} />
        </React.Fragment>
      ))}
    </div>
  )
}
