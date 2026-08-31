import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useGpuixRequired, useWindowInsets, useWindowSize } from '@gpuix/react'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { FlowRuntime } from '../flows/runtime.ts'
import { ChatHeader } from './chat-header.tsx'
import { Composer } from './composer.tsx'
import { ConversationExtensionOverlay } from './conversation-overlay.tsx'
import { copyTextToClipboard } from './clipboard-media.ts'
import { DraftWorkspaceChooser } from './workspace-chooser.tsx'
import { FlowsView } from './flows-view.tsx'
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
import { MotionDiv, SPRING_SETTLE_MS, useSpringProgress } from './motion.ts'
import { ResponsiveLayoutProvider, resolveResponsiveLayout } from './responsive.tsx'
import { TerminalServiceProvider } from './terminal-context.tsx'
import { TerminalDock } from './terminal-dock.tsx'
import { TERMINAL_DOCK_DEFAULT_HEIGHT, TERMINAL_DOCK_MIN_HEIGHT } from './terminal-metrics.ts'
import type { TerminalSessionService } from '../terminal/service.ts'

type Surface = 'chat' | 'flows' | 'settings'
type RightPanel = 'notifications' | 'surfaces' | `surface:${string}`

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
  flows,
  terminals,
  themeManager = defaultThemeManager,
  onQuit,
}: {
  controller: WorkbenchController
  presenters: ReadonlyMap<string, ToolPresenter>
  ui: WorkbenchUiRegistry
  flows?: FlowRuntime | undefined
  terminals?: TerminalSessionService
  themeManager?: ThemeManager
  onQuit?(): void
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const theme = useSyncExternalStore(themeManager.subscribe, themeManager.getSnapshot)
  const uiSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
  const renderer = useGpuixRequired()
  const windowSize = useWindowSize({ intervalMs: 50 })
  const windowInsets = useWindowInsets({ intervalMs: 50 })
  const safeWidth = Math.max(1, windowSize.width - windowInsets.effective.left - windowInsets.effective.right)
  const layout = resolveResponsiveLayout(safeWidth)
  const [surface, setSurface] = useState<Surface>('chat')
  const [composerPickerOpen, setComposerPickerOpen] = useState(false)
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(!layout.navigationOverlay)
  const previousNavigationOverlay = useRef(layout.navigationOverlay)
  const leftSidebarProgress = useSpringProgress(leftSidebarOpen)
  const [bottomTerminalOpen, setBottomTerminalOpen] = useState(false)
  const [bottomTerminalHeight, setBottomTerminalHeight] = useState(TERMINAL_DOCK_DEFAULT_HEIGHT)
  const [bottomTerminalFullscreen, setBottomTerminalFullscreen] = useState(false)
  const [bottomResizeDrag, setBottomResizeDrag] = useState<{ startY: number; startHeight: number } | undefined>()
  const [rightPanel, setRightPanel] = useState<RightPanel | undefined>()
  const [displayedRightPanel, setDisplayedRightPanel] = useState<RightPanel | undefined>()
  const rightPanelProgress = useSpringProgress(Boolean(rightPanel))
  const [panelFullscreen, setPanelFullscreen] = useState(false)
  const fullscreenProgress = Math.min(1, useSpringProgress(panelFullscreen))
  const bottomOpenProgress = useSpringProgress(bottomTerminalOpen)
  const bottomFullscreenProgress = useSpringProgress(bottomTerminalFullscreen && bottomTerminalOpen)
  const diffOpen = rightPanel === surfacePanelId('diff')
  const notificationsOpen = rightPanel === 'notifications'
  const [lastSeenNoticeId, setLastSeenNoticeId] = useState(0)
  const latestNoticeId = state.notices.at(-1)?.id ?? 0
  const unreadCount = state.notices.filter((notice) => notice.id > lastSeenNoticeId).length
  const draft = state.messages.length === 0 && !state.liveAssistant && !state.session.isStreaming
  const closeFlows = useCallback(() => setSurface('chat'), [])
  const openFlowSession = useCallback(() => {
    setSurface('chat')
    setRightPanel(undefined)
    setPanelFullscreen(false)
    if (layout.navigationOverlay) setLeftSidebarOpen(false)
  }, [layout.navigationOverlay])

  useEffect(() => {
    renderer.setWindowTitle?.(state.windowTitle)
  }, [renderer, state.windowTitle])

  useEffect(() => {
    if (previousNavigationOverlay.current === layout.navigationOverlay) return
    previousNavigationOverlay.current = layout.navigationOverlay
    setLeftSidebarOpen(!layout.navigationOverlay)
  }, [layout.navigationOverlay])

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

  const closeOverlayNavigation = () => {
    if (layout.navigationOverlay) setLeftSidebarOpen(false)
  }

  const closeRightPanel = () => {
    setRightPanel(undefined)
    setPanelFullscreen(false)
  }

  const closeBottomTerminal = () => {
    setBottomTerminalOpen(false)
    setBottomTerminalFullscreen(false)
  }

  const toggleBottomTerminal = () => {
    if (bottomTerminalOpen) {
      closeBottomTerminal()
      return
    }
    setBottomTerminalOpen(true)
  }

  useEffect(() => {
    const request = state.uiRequest
    if (!request || request.kind === 'model' || request.kind === 'thinking') return
    controller.completeUiRequest(request.id)
    if (request.kind === 'settings') {
      closeRightPanel()
      if (layout.navigationOverlay) setLeftSidebarOpen(false)
      setSurface('settings')
      return
    }
    if (request.kind === 'sessions') {
      closeRightPanel()
      setSurface('chat')
      setLeftSidebarOpen(true)
      return
    }
    if (request.kind === 'copy') {
      void copyTextToClipboard(request.text).then((copied) => {
        controller.notify(copied ? 'info' : 'warning', copied ? 'Copied last assistant message to clipboard' : 'No system clipboard command is available')
      })
      return
    }
    if (onQuit) onQuit()
    else controller.notify('warning', 'Close the window to quit Heddlework')
  }, [controller, layout.navigationOverlay, onQuit, state.uiRequest])

  useEffect(() => {
    const surfaceId = workbenchSurfaceId(rightPanel)
    if (surfaceId && !uiSnapshot.surfaces.some((candidate) => candidate.id === surfaceId)) closeRightPanel()
  }, [rightPanel, uiSnapshot.surfaces])

  const returnToConversation = () => {
    setSurface('chat')
    closeRightPanel()
    closeOverlayNavigation()
  }

  const toggleNotifications = () => {
    setSurface('chat')
    setPanelFullscreen(false)
    closeOverlayNavigation()
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
    closeOverlayNavigation()
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
    closeOverlayNavigation()
    setDisplayedRightPanel('surfaces')
    setRightPanel('surfaces')
  }

  const selectSurface = (surfaceId: string) => openWorkbenchSurface(surfaceId, true)
  const togglePanelFullscreen = () => {
    if (!layout.panelOverlay) setPanelFullscreen((value) => !value)
  }

  const mainWidth = safeWidth - (layout.navigationOverlay ? 0 : layout.sidebarWidth * leftSidebarProgress)
  const standardPanelWidth = Math.min(mainWidth, Math.max(420, Math.floor(mainWidth * 0.44)))
  const panelWidth = layout.panelOverlay ? safeWidth : displayedRightPanel === 'notifications' ? Math.min(422, mainWidth) : standardPanelWidth
  const boundedRightPanelProgress = Math.max(0, Math.min(1, rightPanelProgress))
  const forcedPanelFullscreen = layout.panelOverlay && Boolean(displayedRightPanel)
  const panelFullscreenVisible = forcedPanelFullscreen || panelFullscreen || fullscreenProgress > 0.001
  const chromeFullscreenProgress = Math.max(fullscreenProgress, bottomFullscreenProgress)
  const animatedSidebarProgress = leftSidebarProgress * (1 - chromeFullscreenProgress)
  const fullscreenVisible = panelFullscreenVisible || bottomFullscreenProgress > 0.001
  const safeHeight = Math.max(1, windowSize.height - windowInsets.effective.top - windowInsets.effective.bottom)
  const restDockHeight = Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.min(Math.floor(safeHeight * 0.7), bottomTerminalHeight))
  const dockHeight = (restDockHeight * (1 - bottomFullscreenProgress) + safeHeight * bottomFullscreenProgress) * bottomOpenProgress * (1 - fullscreenProgress)
  const showBottomDock = Boolean(terminals) && (bottomTerminalOpen || bottomOpenProgress > 0.001) && dockHeight > 0.5
  const panelFullscreenProgress = forcedPanelFullscreen ? boundedRightPanelProgress : fullscreenProgress
  const sidebarToggleLeft = process.platform === 'darwin' ? 90 : layout.navigationOverlay ? 10 : 10 + 54 * animatedSidebarProgress
  const collapsedChromeInset = process.platform === 'darwin' ? 132 : 54
  const contentSidebarProgress = layout.navigationOverlay ? 0 : animatedSidebarProgress
  const flowsTitlebarInset = 24 + (collapsedChromeInset - 24) * (1 - contentSidebarProgress)
  const displayedSurfaceId = workbenchSurfaceId(displayedRightPanel)
  const displayedSurface = uiSnapshot.surfaces.find((candidate) => candidate.id === displayedSurfaceId)
  const SurfaceComponent = displayedSurface?.component
  const panel = displayedRightPanel === 'notifications'
    ? <NotificationLedgerView state={state} fullscreen={panelFullscreenVisible} fullscreenProgress={panelFullscreenProgress} panelWidth={panelWidth} onClear={() => controller.clearNotices()} onClose={closeRightPanel} />
    : displayedRightPanel === 'surfaces'
      ? <SurfacePickerPanel surfaces={uiSnapshot.surfaces} fullscreen={panelFullscreenVisible} fullscreenProgress={panelFullscreenProgress} fullscreenLocked={layout.panelOverlay} panelWidth={panelWidth} onToggleFullscreen={togglePanelFullscreen} onSelect={selectSurface} onClose={closeRightPanel} />
      : SurfaceComponent
        ? <SurfaceComponent fullscreen={panelFullscreenVisible} fullscreenProgress={panelFullscreenProgress} fullscreenLocked={layout.panelOverlay} panelWidth={panelWidth} appearance={theme.resolved} onToggleFullscreen={togglePanelFullscreen} onNewSurface={openSurfacePicker} onClose={closeRightPanel} />
        : null

  const sidebarHost = (
    <div
      testId="left-sidebar-host"
      style={layout.navigationOverlay
        ? { position: 'absolute', top: 0, bottom: 0, left: 0, width: layout.sidebarWidth * animatedSidebarProgress, height: '100%', flexShrink: 0, overflow: 'hidden' }
        : { position: 'relative', width: layout.sidebarWidth * animatedSidebarProgress, height: '100%', flexShrink: 0, overflow: 'hidden' }}
    >
      <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: layout.sidebarWidth }}>
        <WorkbenchSidebar
          width={layout.sidebarWidth}
          state={state}
          controller={controller}
          flowsAvailable={Boolean(flows)}
          flowsActive={surface === 'flows'}
          settingsActive={surface === 'settings'}
          notificationsActive={notificationsOpen}
          unreadCount={unreadCount}
          appearance={theme.resolved}
          onSelectSession={returnToConversation}
          onFlows={() => {
            if (!flows) return
            closeRightPanel()
            closeOverlayNavigation()
            setSurface((current) => current === 'flows' ? 'chat' : 'flows')
          }}
          onSettings={() => {
            closeRightPanel()
            closeOverlayNavigation()
            setSurface((current) => current === 'settings' ? 'chat' : 'settings')
          }}
          onNotifications={toggleNotifications}
        />
      </div>
    </div>
  )

  return (
    <TerminalServiceProvider service={terminals}>
    <ResponsiveLayoutProvider layout={layout}>
      <div testId="workbench-root" style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: colors.background, color: colors.text, overflow: 'hidden' }}>
        <div
          testId="workbench-safe-area"
          style={{ position: 'absolute', top: windowInsets.effective.top, right: windowInsets.effective.right, bottom: windowInsets.effective.bottom, left: windowInsets.effective.left, display: 'flex', flexDirection: 'row', backgroundColor: colors.background, overflow: 'hidden' }}
        >
          {!layout.navigationOverlay && sidebarHost}
          {surface === 'flows' && flows ? (
            <FlowsView state={state} controller={controller} runtime={flows} presenters={presenters} titlebarInset={flowsTitlebarInset} onClose={closeFlows} onOpenSession={openFlowSession} />
          ) : surface === 'settings' ? (
            <SettingsView state={state} controller={controller} theme={theme} onThemeModeChange={(mode) => themeManager.setMode(mode)} terminals={terminals} onClose={() => setSurface('chat')} />
          ) : (
            <div testId="workbench-main" style={{ position: 'relative', display: 'flex', flexDirection: 'row', flexGrow: 1, minWidth: 0, height: '100%', backgroundColor: colors.background, overflow: 'hidden' }}>
              <div style={{ display: 'flex', flexDirection: 'column', width: 0, flexGrow: 1 - fullscreenProgress, minWidth: 0, height: '100%', overflow: 'hidden' }}>
                <div style={{ height: 52 * (1 - bottomFullscreenProgress), flexShrink: 0, overflow: 'hidden' }}>
                  <ChatHeader state={state} controller={controller} diffOpen={diffOpen} terminalOpen={bottomTerminalOpen} leftSidebarProgress={layout.navigationOverlay ? 0 : animatedSidebarProgress} onToggleDiff={toggleDiff} {...(terminals ? { onToggleTerminal: toggleBottomTerminal } : {})} />
                </div>
                <div testId="conversation-body" style={{ position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: Math.max(0.001, 1 - bottomFullscreenProgress), minHeight: 0, overflow: 'hidden' }}>
                  {draft ? (
                    <DraftWorkspaceChooser state={state} controller={controller} />
                  ) : (
                    <>
                      <Transcript state={state} presenters={presenters} appearance={theme.resolved} interactionDisabled={composerPickerOpen} onOpenDiff={() => openDiff()} onRevert={(entryId) => void controller.navigateTree(entryId)} onDismissNotice={(id) => controller.dismissNotice(id)} onLoadEarlier={controller.loadEarlierMessages} />
                      <TranscriptFade />
                      <Composer state={state} controller={controller} onPickerOpenChange={setComposerPickerOpen} />
                    </>
                  )}
                  <ConversationExtensionOverlay state={state} controller={controller} />
                </div>
                {showBottomDock && terminals && (
                  <TerminalDock
                    service={terminals}
                    open={bottomTerminalOpen}
                    fullscreen={bottomTerminalFullscreen}
                    fullscreenProgress={bottomFullscreenProgress}
                    height={dockHeight}
                    width={Math.max(1, safeWidth - (layout.navigationOverlay ? 0 : layout.sidebarWidth * animatedSidebarProgress) - (displayedRightPanel && !layout.panelOverlay ? panelWidth * boundedRightPanelProgress * (1 - fullscreenProgress) * (1 - bottomFullscreenProgress) : 0))}
                    appearance={theme.resolved}
                    onResizeStart={(y) => setBottomResizeDrag({ startY: y, startHeight: restDockHeight })}
                    onToggleFullscreen={() => setBottomTerminalFullscreen((value) => !value)}
                    onClose={closeBottomTerminal}
                  />
                )}
              </div>
              {panel && (
                <div
                  testId="right-panel-host"
                  style={layout.panelOverlay
                    ? { position: 'absolute', top: 0, right: 0, bottom: 0, width: safeWidth * boundedRightPanelProgress, minWidth: 0, height: '100%', flexShrink: 0, overflow: 'hidden' }
                    : { position: 'relative', width: panelWidth * rightPanelProgress * (1 - fullscreenProgress) * (1 - bottomFullscreenProgress), flexGrow: fullscreenProgress * rightPanelProgress * (1 - bottomFullscreenProgress), minWidth: 0, height: '100%', flexShrink: 0, overflow: 'hidden' }}
                >
                  <div style={layout.panelOverlay
                    ? { position: 'absolute', top: 0, right: 0, bottom: 0, width: safeWidth }
                    : { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
                  >
                    {panel}
                  </div>
                </div>
              )}
            </div>
          )}
          {layout.navigationOverlay && !panel && animatedSidebarProgress > 0.001 && (
            <>
              <MotionDiv
                testId="navigation-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: Math.min(0.72, animatedSidebarProgress * 0.72) }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
                style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#00000099', pointerEvents: leftSidebarOpen ? 'auto' : 'none' }}
                onClick={() => setLeftSidebarOpen(false)}
              />
              {sidebarHost}
            </>
          )}
          {bottomResizeDrag && (
            <div
              testId="terminal-dock-drag-overlay"
              style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, cursor: 'ns-resize' }}
              onMouseMove={(event) => {
                const delta = bottomResizeDrag.startY - (event.y ?? 0)
                setBottomTerminalHeight(Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.min(Math.floor(safeHeight * 0.75), bottomResizeDrag.startHeight + delta)))
              }}
              onMouseUp={() => setBottomResizeDrag(undefined)}
            />
          )}
          {!fullscreenVisible && (
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
      </div>
    </ResponsiveLayoutProvider>
    </TerminalServiceProvider>
  )
}

function TranscriptFade() {
  const layers = ['08', '18', '2C', '45', '65', '88', 'AC', 'CE', 'E8', 'F8']
  return (
    <div testId="transcript-bottom-fade" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 240, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
      {layers.map((alpha) => (
        <React.Fragment key={alpha}>
          <div style={{ height: 24, flexShrink: 0, backgroundColor: `${colors.background}${alpha}`, pointerEvents: 'none' }} />
        </React.Fragment>
      ))}
    </div>
  )
}
