import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { WorkbenchController } from '../workbench/controller.ts'
import { ChatHeader } from './chat-header.tsx'
import { Composer } from './composer.tsx'
import { DiffPanel } from './diff-panel.tsx'
import { NotificationLedgerView } from './notifications.tsx'
import { SettingsView } from './settings-view.tsx'
import { WorkbenchSidebar } from './sidebar.tsx'
import { SurfacePickerPanel, SurfacePlaceholderPanel, type SurfaceKind } from './surface-picker.tsx'
import { Transcript } from './transcript.tsx'
import type { ToolPresenter } from './tool-presenters.ts'
import { Icon } from './icons.tsx'
import { colors } from './theme.ts'

type Surface = 'chat' | 'settings'
type DeferredSurface = Exclude<SurfaceKind, 'diff'>
type RightPanel = 'diff' | 'notifications' | 'surfaces' | DeferredSurface

export const PANEL_TRANSITION_MS = 200
const LEFT_SIDEBAR_WIDTH = 256

export function WorkbenchApp({
  controller,
  presenters,
}: {
  controller: WorkbenchController
  presenters: ReadonlyMap<string, ToolPresenter>
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const renderer = useGpuixRequired()
  const [surface, setSurface] = useState<Surface>('chat')
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true)
  const leftSidebarProgress = useAnimatedProgress(leftSidebarOpen)
  const [rightPanel, setRightPanel] = useState<RightPanel | undefined>()
  const [displayedRightPanel, setDisplayedRightPanel] = useState<RightPanel | undefined>()
  const rightPanelProgress = useAnimatedProgress(Boolean(rightPanel))
  const [panelFullscreen, setPanelFullscreen] = useState(false)
  const diffOpen = rightPanel === 'diff'
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
    const timer = setTimeout(() => setDisplayedRightPanel(undefined), PANEL_TRANSITION_MS + 32)
    return () => clearTimeout(timer)
  }, [rightPanel])

  const closeRightPanel = () => {
    setRightPanel(undefined)
    setPanelFullscreen(false)
  }

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

  const openDiff = (preserveFullscreen = false) => {
    if (!diffOpen) void controller.refreshWorkspaceDiff()
    setSurface('chat')
    if (!preserveFullscreen) setPanelFullscreen(false)
    setDisplayedRightPanel('diff')
    setRightPanel('diff')
  }

  const toggleDiff = () => {
    if (diffOpen) closeRightPanel()
    else openDiff()
  }

  const openSurfacePicker = () => {
    setSurface('chat')
    setDisplayedRightPanel('surfaces')
    setRightPanel('surfaces')
  }

  const selectSurface = (selection: SurfaceKind) => {
    if (selection === 'diff') openDiff(true)
    else {
      setDisplayedRightPanel(selection)
      setRightPanel(selection)
    }
  }

  const togglePanelFullscreen = () => setPanelFullscreen((value) => !value)

  const shellWidth = renderer.getWindowSize?.().width ?? 1_200
  const mainWidth = shellWidth - LEFT_SIDEBAR_WIDTH * leftSidebarProgress
  const standardPanelWidth = Math.max(420, Math.floor(mainWidth * 0.44))
  const panelWidth = displayedRightPanel === 'notifications' ? 422 : standardPanelWidth
  const sidebarToggleLeft = process.platform === 'darwin' ? 90 : 10 + 54 * leftSidebarProgress
  const panel = displayedRightPanel === 'diff'
    ? <DiffPanel diff={state.workspaceDiff} controller={controller} fullscreen={panelFullscreen} panelWidth={panelWidth} onToggleFullscreen={togglePanelFullscreen} onNewSurface={openSurfacePicker} onClose={closeRightPanel} />
    : displayedRightPanel === 'notifications'
      ? <NotificationLedgerView state={state} panelWidth={panelWidth} />
      : displayedRightPanel === 'surfaces'
        ? <SurfacePickerPanel fullscreen={panelFullscreen} panelWidth={panelWidth} onToggleFullscreen={togglePanelFullscreen} onSelect={selectSurface} onClose={closeRightPanel} />
        : displayedRightPanel === 'browser' || displayedRightPanel === 'terminal' || displayedRightPanel === 'files' || displayedRightPanel === 'agents'
          ? <SurfacePlaceholderPanel surface={displayedRightPanel} fullscreen={panelFullscreen} panelWidth={panelWidth} onToggleFullscreen={togglePanelFullscreen} onNew={openSurfacePicker} onClose={closeRightPanel} />
          : null

  return (
    <div testId="workbench-root" style={{ position: 'relative', display: 'flex', flexDirection: 'row', width: '100%', height: '100%', backgroundColor: colors.background, color: colors.text, overflow: 'hidden' }}>
      {panelFullscreen && panel ? panel : (
        <>
          <div testId="left-sidebar-host" style={{ position: 'relative', width: LEFT_SIDEBAR_WIDTH * leftSidebarProgress, height: '100%', flexShrink: 0, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: LEFT_SIDEBAR_WIDTH }}>
              <WorkbenchSidebar
                state={state}
                controller={controller}
                settingsActive={surface === 'settings'}
                notificationsActive={notificationsOpen}
                unreadCount={unreadCount}
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
            <SettingsView state={state} controller={controller} onClose={() => setSurface('chat')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, minWidth: 0, height: '100%', backgroundColor: colors.background }}>
              <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, height: '100%' }}>
                <ChatHeader state={state} controller={controller} diffOpen={diffOpen} leftSidebarProgress={leftSidebarProgress} onToggleDiff={toggleDiff} />
                <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
                  {draft ? (
                    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 25, paddingLeft: 20, paddingRight: 20, paddingBottom: 74 }}>
                      <text style={{ color: colors.text, fontSize: 26, fontWeight: 500, maxWidth: 900, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`What should we build in ${projectName}?`}</text>
                      <Composer state={state} controller={controller} draft />
                    </div>
                  ) : (
                    <>
                      <Transcript state={state} presenters={presenters} onOpenDiff={() => openDiff()} onRevert={(entryId) => void controller.forkFrom(entryId)} />
                      <TranscriptFade />
                      <Composer state={state} controller={controller} />
                    </>
                  )}
                </div>
              </div>
              {panel && (
                <div testId="right-panel-host" style={{ position: 'relative', width: panelWidth * rightPanelProgress, height: '100%', flexShrink: 0, overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: panelWidth }}>{panel}</div>
                </div>
              )}
            </div>
          )}
        </>
      )}
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

function useAnimatedProgress(open: boolean): number {
  const target = open ? 1 : 0
  const [progress, setProgress] = useState(target)
  const progressRef = useRef(progress)
  useEffect(() => {
    const from = progressRef.current
    const distance = Math.abs(target - from)
    if (distance < 0.001) {
      progressRef.current = target
      setProgress(target)
      return
    }
    const startedAt = Date.now()
    const duration = PANEL_TRANSITION_MS * distance
    const timer = setInterval(() => {
      const elapsed = Math.min(1, (Date.now() - startedAt) / duration)
      const next = from + (target - from) * elapsed
      progressRef.current = next
      setProgress(next)
      if (elapsed >= 1) clearInterval(timer)
    }, 16)
    return () => clearInterval(timer)
  }, [target])
  return progress
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
