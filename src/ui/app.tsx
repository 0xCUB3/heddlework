import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import uiContract from '../workbench/ui-contract.json'
import { useGpuixRequired, useWindowInsets, useWindowSize } from '@gpuix/react'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { FlowRuntime } from '../flows/runtime.ts'
import { ChatHeader } from './chat-header.tsx'
import { Composer } from './composer.tsx'
import { ConversationExtensionOverlay } from './conversation-overlay.tsx'
import { copyTextToClipboard } from './clipboard-media.ts'
import { DraftWorkspaceChooser } from './workspace-chooser.tsx'
import { FlowsView } from './flows-view.tsx'
import { ComposerNotificationStack, NotificationLedgerView } from './notifications.tsx'
import { watchDesktopAttention } from './os-notifications.ts'
import { SettingsView } from './settings-view.tsx'
import { WorkbenchSidebar } from './sidebar.tsx'
import { SurfacePickerPanel } from './surface-picker.tsx'
import { Transcript } from './transcript.tsx'
import type { WorkbenchUiRegistry } from './extensions.ts'
import type { ToolPresenter } from './tool-presenters.ts'
import { Icon } from './icons.tsx'
import { colors, nativeTheme } from './theme.ts'
import { defaultThemeManager, type ThemeManager } from './theme-manager.ts'
import { LAYOUT_MOTION_TRANSITION, MotionDiv, SPRING_SETTLE_MS } from './motion.ts'
import { ResponsiveLayoutProvider, resolveResponsiveLayout } from './responsive.tsx'
import { TerminalProjectionSuspensionProvider, TerminalServiceProvider } from './terminal-context.tsx'
import { TerminalDock } from './terminal-dock.tsx'
import { TERMINAL_DOCK_DEFAULT_HEIGHT, TERMINAL_DOCK_MIN_HEIGHT } from './terminal-metrics.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import type { BrowserSessionService } from '../browser/service.ts'
import { BrowserServiceProvider } from './browser-context.tsx'
import { BrowserNativeHost } from './browser-host.tsx'
import type { RemoteAccessService } from '../host/remote-access.ts'
import type { TailnetServeService } from '../host/tailnet-serve.ts'
import type { PluginHost } from '../plugins/host.ts'
import type { SleepPreventionService } from '../power/service.ts'
import type { UpdateService } from '../updates/service.ts'
import { isLedgerNotice, toastNotices, unreadLedgerNotices } from '../workbench/notices.ts'
import { clampPanelSize, draggedPanelSize, type LayoutStorage, type PanelSizes, type ResizePanel } from './panel-layout.ts'
import { ResizeHandle } from './resize-handle.tsx'
import { DESKTOP_CLIENT_ID } from '../workbench/presence.ts'

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
  browsers,
  browserIntegrations,
  sleepPrevention,
  themeManager = defaultThemeManager,
  remoteAccess,
  tailnetServe,
  pluginHost,
  updates,
  onQuit,
  layoutStorage,
}: {
  controller: WorkbenchController
  presenters: ReadonlyMap<string, ToolPresenter>
  ui: WorkbenchUiRegistry
  flows?: FlowRuntime | undefined
  remoteAccess?: RemoteAccessService | undefined
  tailnetServe?: TailnetServeService | undefined
  pluginHost?: PluginHost | undefined
  updates?: UpdateService | undefined
  terminals?: TerminalSessionService
  browserIntegrations?: BrowserIntegrationService
  sleepPrevention?: SleepPreventionService
  browsers?: BrowserSessionService
  themeManager?: ThemeManager
  onQuit?(): void
  layoutStorage?: LayoutStorage
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const theme = useSyncExternalStore(themeManager.subscribe, themeManager.getSnapshot)
  const uiSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
  const renderer = useGpuixRequired()
  const windowSize = useWindowSize({ intervalMs: 50 })
  const windowInsets = useWindowInsets({ intervalMs: 50 })
  const safeWidth = Math.max(1, windowSize.width - windowInsets.effective.left - windowInsets.effective.right)
  const baseLayout = resolveResponsiveLayout(safeWidth)
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(() => layoutStorage?.read() ?? {})
  const panelSizesRef = useRef(panelSizes)
  const [resizeDrag, setResizeDrag] = useState<{ panel: ResizePanel; start: number; size: number; before: PanelSizes } | undefined>()
  const [surface, setSurface] = useState<Surface>('chat')
  const [composerPickerOpen, setComposerPickerOpen] = useState(false)
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(!baseLayout.navigationOverlay)
  const [leftSidebarMounted, setLeftSidebarMounted] = useState(!baseLayout.navigationOverlay)
  const previousNavigationOverlay = useRef(baseLayout.navigationOverlay)
  const [bottomTerminalOpen, setBottomTerminalOpen] = useState(false)
  const [bottomTerminalMounted, setBottomTerminalMounted] = useState(false)
  const [bottomTerminalFullscreen, setBottomTerminalFullscreen] = useState(false)
  const [rightPanel, setRightPanel] = useState<RightPanel | undefined>()
  const layout = { ...baseLayout, sidebarWidth: baseLayout.navigationOverlay ? baseLayout.sidebarWidth : clampPanelSize(panelSizes.sidebar ?? baseLayout.sidebarWidth, 220, Math.min(440, safeWidth - 360 - (rightPanel ? 320 : 0))) }
  const [displayedRightPanel, setDisplayedRightPanel] = useState<RightPanel | undefined>()
  const [panelFullscreen, setPanelFullscreen] = useState(false)
  const [panelFullscreenRendered, setPanelFullscreenRendered] = useState(false)
  const forcedPanelFullscreen = layout.panelOverlay && Boolean(rightPanel)
  const diffOpen = rightPanel === surfacePanelId('diff')
  const notificationsOpen = rightPanel === 'notifications'
  const [lastSeenNoticeId, setLastSeenNoticeId] = useState(0)
  const latestNoticeId = state.notices.filter(isLedgerNotice).at(-1)?.id ?? 0
  const unreadCount = unreadLedgerNotices(state.notices).filter((notice) => notice.id > lastSeenNoticeId).length
  const toasts = toastNotices(state.notices)
  const newestToastId = toasts.at(-1)?.id
  const draft = state.messages.length === 0 && !state.liveAssistant && !state.session.isStreaming
  const setLeftSidebarVisibility = useCallback((open: boolean) => {
    if (!open) setLeftSidebarMounted(true)
    setLeftSidebarOpen(open)
  }, [])
  const closeFlows = useCallback(() => setSurface('chat'), [])
  const openFlowSession = useCallback(() => {
    setSurface('chat')
    setRightPanel(undefined)
    setPanelFullscreen(false)
    if (layout.navigationOverlay) setLeftSidebarVisibility(false)
  }, [layout.navigationOverlay, setLeftSidebarVisibility])

  useEffect(() => {
    renderer.setWindowTitle?.(state.windowTitle)
  }, [renderer, state.windowTitle])

  useEffect(() => {
    if (previousNavigationOverlay.current === layout.navigationOverlay) return
    previousNavigationOverlay.current = layout.navigationOverlay
    setLeftSidebarOpen(!layout.navigationOverlay)
    setLeftSidebarMounted(!layout.navigationOverlay)
  }, [layout.navigationOverlay])

  useEffect(() => {
    if (leftSidebarOpen) return
    const timer = setTimeout(() => setLeftSidebarMounted(false), SPRING_SETTLE_MS + 32)
    return () => clearTimeout(timer)
  }, [leftSidebarOpen])

  useEffect(() => {
    if (bottomTerminalOpen) return
    const timer = setTimeout(() => setBottomTerminalMounted(false), SPRING_SETTLE_MS + 32)
    return () => clearTimeout(timer)
  }, [bottomTerminalOpen])

  useEffect(() => {
    if (notificationsOpen) {
      setLastSeenNoticeId(latestNoticeId)
      controller.markNoticesRead()
    }
  }, [controller, latestNoticeId, notificationsOpen])

  useEffect(() => {
    const report = (visibility: 'focused' | 'hidden' = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 'hidden' : 'focused') => {
      controller.presence.upsert({
        clientId: DESKTOP_CLIENT_ID,
        surface: 'desktop',
        visibility,
        ...(state.session.sessionFile ? { sessionPath: state.session.sessionFile } : {}),
      })
    }
    report()
    if (typeof document === 'undefined') return undefined
    const onVisibility = () => report()
    const onFocus = () => report('focused')
    const onBlur = () => report('hidden')
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [controller, state.session.sessionFile])

  useEffect(() => watchDesktopAttention(controller), [controller])

  useEffect(() => {
    if (newestToastId === undefined) return undefined
    const timer = setTimeout(() => controller.dismissNotice(newestToastId), 4_000)
    return () => clearTimeout(timer)
  }, [controller, newestToastId])

  useEffect(() => {
    if (rightPanel) {
      setDisplayedRightPanel(rightPanel)
      return
    }
    setPanelFullscreen(false)
    const timer = setTimeout(() => setDisplayedRightPanel(undefined), SPRING_SETTLE_MS + 32)
    return () => clearTimeout(timer)
  }, [rightPanel])

  useEffect(() => {
    if (forcedPanelFullscreen) {
      setPanelFullscreenRendered(true)
      return
    }
    if (panelFullscreen) return
    const timer = setTimeout(() => setPanelFullscreenRendered(false), SPRING_SETTLE_MS + 32)
    return () => clearTimeout(timer)
  }, [forcedPanelFullscreen, panelFullscreen])

  const closeOverlayNavigation = () => {
    if (layout.navigationOverlay) setLeftSidebarVisibility(false)
  }

  const closeRightPanel = () => {
    setRightPanel(undefined)
    setPanelFullscreen(false)
  }

  const closeBottomTerminal = () => {
    setBottomTerminalMounted(true)
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
      if (layout.navigationOverlay) setLeftSidebarVisibility(false)
      setSurface('settings')
      return
    }
    if (request.kind === 'sessions') {
      closeRightPanel()
      setSurface('chat')
      setLeftSidebarVisibility(true)
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
    if (layout.panelOverlay) return
    if (!panelFullscreen) setPanelFullscreenRendered(true)
    setPanelFullscreen(!panelFullscreen)
  }

  const rightPanelOpen = Boolean(rightPanel)
  const bottomFullscreenVisible = bottomTerminalFullscreen && bottomTerminalOpen
  const panelFullscreenTarget = forcedPanelFullscreen || panelFullscreen
  const panelFullscreenVisible = panelFullscreenTarget || panelFullscreenRendered
  const fullscreenVisible = panelFullscreenVisible || bottomFullscreenVisible
  const animatedSidebarProgress = leftSidebarOpen && !panelFullscreenTarget && !bottomFullscreenVisible ? 1 : 0
  const mainWidth = safeWidth - (layout.navigationOverlay ? 0 : layout.sidebarWidth * animatedSidebarProgress)
  const standardPanelWidth = displayedRightPanel === 'notifications' ? 422 : Math.max(420, Math.floor(mainWidth * 0.44))
  const panelWidth = layout.panelOverlay ? safeWidth : clampPanelSize(panelSizes.right ?? standardPanelWidth, 320, Math.max(1, mainWidth - 320))
  const safeHeight = Math.max(1, windowSize.height - windowInsets.effective.top - windowInsets.effective.bottom)
  const restDockHeight = clampPanelSize(panelSizes.terminal ?? TERMINAL_DOCK_DEFAULT_HEIGHT, TERMINAL_DOCK_MIN_HEIGHT, Math.max(1, safeHeight - 160))
  const dockHeight = !bottomTerminalOpen || panelFullscreenTarget ? 0 : bottomFullscreenVisible ? safeHeight : restDockHeight
  const showBottomDock = Boolean(terminals) && (bottomTerminalOpen || bottomTerminalMounted)
  const panelFullscreenProgress = panelFullscreenTarget ? 1 : 0
  const sidebarToggleLeft = process.platform === 'darwin' ? 90 : layout.navigationOverlay ? 10 : 10 + 54 * animatedSidebarProgress
  const collapsedChromeInset = process.platform === 'darwin' ? 132 : 54
  const contentSidebarProgress = layout.navigationOverlay ? 0 : animatedSidebarProgress
  const flowsTitlebarInset = 24 + (collapsedChromeInset - 24) * (1 - contentSidebarProgress)
  const settingsTitlebarInset = 18 + (collapsedChromeInset - 18) * (1 - contentSidebarProgress)
  const conversationFlexGrow = panelFullscreenTarget ? 0 : 1
  const conversationBodyFlexGrow = bottomFullscreenVisible ? 0.001 : 1
  const chatHeaderHeight = bottomFullscreenVisible ? 0 : uiContract.layout.headerHeight
  const rightPanelHostWidth = rightPanelOpen && !panelFullscreenTarget && !bottomFullscreenVisible ? panelWidth : 0
  const rightPanelHostFlexGrow = rightPanelOpen && panelFullscreenTarget && !bottomFullscreenVisible ? 1 : 0
  const bottomFullscreenProgress = bottomFullscreenVisible ? 1 : 0
  const dockWidth = Math.max(1, safeWidth
    - (layout.navigationOverlay ? 0 : layout.sidebarWidth * animatedSidebarProgress)
    - (rightPanelOpen && !layout.panelOverlay && !panelFullscreenTarget && !bottomFullscreenVisible ? panelWidth : 0))
  const displayedSurfaceId = workbenchSurfaceId(displayedRightPanel)
  const rightTerminalSuspended = bottomTerminalFullscreen && displayedSurfaceId === 'terminal'
  const displayedSurface = uiSnapshot.surfaces.find((candidate) => candidate.id === displayedSurfaceId)
  const SurfaceComponent = displayedSurface?.component
  const panel = displayedRightPanel === 'notifications'
    ? <NotificationLedgerView state={state} fullscreen={panelFullscreenVisible} fullscreenProgress={panelFullscreenProgress} panelWidth={panelWidth} onClear={() => controller.clearNotices()} onClose={closeRightPanel} onOpen={(id) => { void controller.activateNotice(id); closeRightPanel() }} />
    : displayedRightPanel === 'surfaces'
      ? <SurfacePickerPanel surfaces={uiSnapshot.surfaces} fullscreen={panelFullscreenVisible} fullscreenProgress={panelFullscreenProgress} fullscreenLocked={layout.panelOverlay} panelWidth={panelWidth} onToggleFullscreen={togglePanelFullscreen} onSelect={selectSurface} onClose={closeRightPanel} />
      : SurfaceComponent
        ? <SurfaceComponent fullscreen={panelFullscreenVisible} fullscreenProgress={panelFullscreenProgress} fullscreenLocked={layout.panelOverlay} panelWidth={panelWidth} appearance={theme.resolved} onToggleFullscreen={togglePanelFullscreen} onNewSurface={openSurfacePicker} onClose={closeRightPanel} />
        : null

  const maximumSize = (panel: ResizePanel) => panel === 'sidebar'
    ? Math.min(440, safeWidth - 360 - (rightPanelOpen ? panelWidth : 0))
    : panel === 'right' ? Math.min(800, mainWidth - 320) : Math.max(1, safeHeight - 160)
  const updateSizes = (next: PanelSizes) => { panelSizesRef.current = next; setPanelSizes(next) }
  const beginResize = (panel: ResizePanel, start: number, size: number) => setResizeDrag({ panel, start, size, before: panelSizesRef.current })
  const finishResize = () => { if (resizeDrag) layoutStorage?.write(panelSizesRef.current); setResizeDrag(undefined) }
  const resizeByKey = (panel: ResizePanel, size: number, delta: number) => {
    const next = { ...panelSizesRef.current, [panel]: draggedPanelSize(panel, size, delta, maximumSize(panel)) }
    updateSizes(next); layoutStorage?.write(next)
  }
  const moveResize = (event: { x?: number; y?: number }) => {
    if (!resizeDrag) return
    const position = resizeDrag.panel === 'terminal' ? event.y : event.x
    if (position === undefined) return
    updateSizes({ ...panelSizesRef.current, [resizeDrag.panel]: draggedPanelSize(resizeDrag.panel, resizeDrag.size, position - resizeDrag.start, maximumSize(resizeDrag.panel)) })
  }

  const sidebarHost = (
    <MotionDiv
      initial={layout.navigationOverlay ? { width: 0 } : false}
      animate={{ width: layout.sidebarWidth * animatedSidebarProgress }}
      transition={resizeDrag ? { duration: 0 } : LAYOUT_MOTION_TRANSITION}
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
      {!layout.navigationOverlay && animatedSidebarProgress > 0 && <ResizeHandle testId="left-sidebar-resize" edge="right" onStart={x => beginResize('sidebar', x, layout.sidebarWidth)} onStep={delta => resizeByKey('sidebar', layout.sidebarWidth, delta)} />}
    </MotionDiv>
  )

  return (
    <TerminalServiceProvider service={terminals}>
    <BrowserServiceProvider service={browsers}>
    <ResponsiveLayoutProvider layout={layout}>
      <div testId="workbench-root" style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: colors.background, color: colors.text, fontFamily: nativeTheme.fontSans, overflow: 'hidden' }}>
        <div
          testId="workbench-safe-area"
          style={{ position: 'absolute', top: windowInsets.effective.top, right: windowInsets.effective.right, bottom: windowInsets.effective.bottom, left: windowInsets.effective.left, display: 'flex', flexDirection: 'row', backgroundColor: colors.background, overflow: 'hidden' }}
        >
          {!layout.navigationOverlay && sidebarHost}
          {surface === 'flows' && flows ? (
            <FlowsView state={state} controller={controller} runtime={flows} presenters={presenters} titlebarInset={flowsTitlebarInset} onClose={closeFlows} onOpenSession={openFlowSession} />
          ) : surface === 'settings' ? (
            <SettingsView browserIntegrations={browserIntegrations} sleepPrevention={sleepPrevention} state={state} controller={controller} remoteAccess={remoteAccess} tailnetServe={tailnetServe} pluginHost={pluginHost} updates={updates} theme={theme} titlebarInset={settingsTitlebarInset} onThemeModeChange={(mode) => themeManager.setMode(mode)} onFontsChange={(fonts) => themeManager.setFonts(fonts)} onFontsReset={() => themeManager.resetFonts()} terminals={terminals} browsers={browsers} onClose={() => setSurface('chat')} />
          ) : (
            <div testId="workbench-main" style={{ position: 'relative', display: 'flex', flexDirection: 'row', flexGrow: 1, minWidth: 0, height: '100%', backgroundColor: colors.background, overflow: 'hidden' }}>
              <MotionDiv initial={false} animate={{ flexGrow: conversationFlexGrow }} transition={LAYOUT_MOTION_TRANSITION} style={{ display: 'flex', flexDirection: 'column', width: 0, flexGrow: conversationFlexGrow, minWidth: 0, height: '100%', overflow: 'hidden' }}>
                <MotionDiv initial={false} animate={{ height: chatHeaderHeight }} transition={LAYOUT_MOTION_TRANSITION} style={{ height: chatHeaderHeight, flexShrink: 0, overflow: 'hidden' }}>
                  <ChatHeader state={state} controller={controller} diffOpen={diffOpen} terminalOpen={bottomTerminalOpen} leftSidebarProgress={layout.navigationOverlay ? 0 : animatedSidebarProgress} onToggleDiff={toggleDiff} {...(terminals ? { onToggleTerminal: toggleBottomTerminal } : {})} />
                </MotionDiv>
                <MotionDiv initial={false} animate={{ flexGrow: conversationBodyFlexGrow }} transition={LAYOUT_MOTION_TRANSITION} testId="conversation-body" style={{ position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: conversationBodyFlexGrow, minHeight: 0, overflow: 'hidden' }}>
                  {draft ? (
                    <>
                      <DraftWorkspaceChooser state={state} controller={controller} />
                      <ComposerNotificationStack notices={toasts} onDismiss={(id) => controller.dismissNotice(id)} onClear={() => {
                        for (const notice of toasts) controller.dismissNotice(notice.id)
                      }} />
                    </>
                  ) : (
                    <>
                      <Transcript state={state} presenters={presenters} appearance={theme.resolved} interactionDisabled={composerPickerOpen} onOpenDiff={() => openDiff()} onRevert={(entryId) => void controller.navigateTree(entryId)} onDismissNotice={(id) => controller.dismissNotice(id)} onLoadEarlier={controller.loadEarlierMessages} />
                      <TranscriptFade />
                      <ComposerNotificationStack notices={toasts} onDismiss={(id) => controller.dismissNotice(id)} onClear={() => {
                        for (const notice of toasts) controller.dismissNotice(notice.id)
                      }} />
                      <Composer state={state} controller={controller} onPickerOpenChange={setComposerPickerOpen} />
                    </>
                  )}
                  <ConversationExtensionOverlay state={state} controller={controller} />
                </MotionDiv>
                {showBottomDock && terminals && (
                  <TerminalDock
                    service={terminals}
                    open={bottomTerminalOpen}
                    fullscreen={bottomTerminalFullscreen}
                    fullscreenProgress={bottomFullscreenProgress}
                    height={dockHeight}
                    width={dockWidth}
                    appearance={theme.resolved}
                    resizing={Boolean(resizeDrag)}
                    onResizeStart={(y) => beginResize('terminal', y, restDockHeight)}
                    onResizeStep={(delta) => resizeByKey('terminal', restDockHeight, delta)}
                    onToggleFullscreen={() => setBottomTerminalFullscreen((value) => !value)}
                    onClose={closeBottomTerminal}
                  />
                )}
              </MotionDiv>
              {panel && (
                <MotionDiv
                  initial={{ width: 0, flexGrow: 0 }}
                  animate={{
                    width: layout.panelOverlay ? (rightPanelOpen ? safeWidth : 0) : rightPanelHostWidth,
                    flexGrow: layout.panelOverlay ? 0 : rightPanelHostFlexGrow,
                  }}
                  transition={resizeDrag ? { duration: 0 } : LAYOUT_MOTION_TRANSITION}
                  testId="right-panel-host"
                  style={layout.panelOverlay
                    ? { position: 'absolute', top: 0, right: 0, bottom: 0, width: rightPanelOpen ? safeWidth : 0, minWidth: 0, height: '100%', flexShrink: 0, overflow: 'hidden' }
                    : { position: 'relative', width: rightPanelHostWidth, flexGrow: rightPanelHostFlexGrow, minWidth: 0, height: '100%', flexShrink: 0, overflow: 'hidden' }}
                >
                  <div style={layout.panelOverlay
                    ? { position: 'absolute', top: 0, right: 0, bottom: 0, width: safeWidth }
                    : { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
                  >
                    <TerminalProjectionSuspensionProvider suspended={rightTerminalSuspended}>
                      {panel}
                    </TerminalProjectionSuspensionProvider>
                  </div>
                  {!layout.panelOverlay && !panelFullscreenVisible && rightPanelOpen && <ResizeHandle testId="right-panel-resize" edge="left" onStart={x => beginResize('right', x, panelWidth)} onStep={delta => resizeByKey('right', panelWidth, delta)} />}
                </MotionDiv>
              )}
            </div>
          )}
          {layout.navigationOverlay && !panel && (leftSidebarOpen || leftSidebarMounted) && (
            <>
              <MotionDiv
                testId="navigation-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: Math.min(0.72, animatedSidebarProgress * 0.72) }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
                style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#00000099', pointerEvents: leftSidebarOpen ? 'auto' : 'none' }}
                onClick={() => setLeftSidebarVisibility(false)}
              />
              {sidebarHost}
            </>
          )}
          {resizeDrag && <div testId={resizeDrag.panel === 'terminal' ? 'terminal-dock-drag-overlay' : 'panel-resize-overlay'} autoFocus tabIndex={0}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, userSelect: 'none', cursor: resizeDrag.panel === 'terminal' ? 'ns-resize' : 'ew-resize' }}
            onMouseMove={moveResize} onMouseUp={finishResize} onMouseLeave={finishResize}
            onKeyDown={event => { if (event.key === 'escape') { updateSizes(resizeDrag.before); setResizeDrag(undefined) } }} />}
          {browsers && <BrowserNativeHost service={browsers} suspended={Boolean(resizeDrag)} />}
          {!fullscreenVisible && (
            <MotionDiv
              initial={false}
              animate={{ left: sidebarToggleLeft }}
              transition={LAYOUT_MOTION_TRANSITION}
              testId="toggle-left-sidebar"
              tabIndex={0}
              style={{ position: 'absolute', top: 12, left: sidebarToggleLeft, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.hover } }}
              onClick={() => setLeftSidebarVisibility(!leftSidebarOpen)}
            >
              <div style={{ width: 15, height: 15, pointerEvents: 'none' }}><Icon name={leftSidebarOpen ? 'panelLeftClose' : 'panelLeft'} size={15} color={colors.textMuted} /></div>
            </MotionDiv>
          )}
          {toasts.length > 0 && surface !== 'chat' ? (
            <div testId="global-notification-stack" style={{ position: 'absolute', left: 0, right: 0, bottom: 28, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ pointerEvents: 'auto', width: '100%', maxWidth: 768, paddingLeft: 20, paddingRight: 20 }}>
                <ComposerNotificationStack notices={toasts} onDismiss={(id) => controller.dismissNotice(id)} onClear={() => {
                  for (const notice of toasts) controller.dismissNotice(notice.id)
                }} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </ResponsiveLayoutProvider>
    </BrowserServiceProvider>
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
