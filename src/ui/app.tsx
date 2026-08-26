import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { WorkbenchController } from '../workbench/controller.ts'
import { ChatHeader } from './chat-header.tsx'
import { Composer } from './composer.tsx'
import { DiffPanel } from './diff-panel.tsx'
import { NotificationLedgerView, NotificationToast } from './notifications.tsx'
import { SettingsView } from './settings-view.tsx'
import { WorkbenchSidebar } from './sidebar.tsx'
import { Transcript } from './transcript.tsx'
import type { ToolPresenter } from './tool-presenters.ts'
import { colors } from './theme.ts'

type Surface = 'chat' | 'settings' | 'notifications'

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
  const [diffOpen, setDiffOpen] = useState(false)
  const [lastSeenNoticeId, setLastSeenNoticeId] = useState(0)
  const latestNoticeId = state.notices.at(-1)?.id ?? 0
  const unreadCount = state.notices.filter((notice) => notice.id > lastSeenNoticeId).length
  const draft = state.messages.length === 0 && !state.liveAssistant && !state.session.isStreaming
  const projectName = state.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? state.workspacePath

  useEffect(() => {
    renderer.setWindowTitle?.(state.windowTitle)
  }, [renderer, state.windowTitle])

  useEffect(() => {
    if (surface === 'notifications') setLastSeenNoticeId(latestNoticeId)
  }, [latestNoticeId, surface])

  const toggleNotifications = () => {
    setSurface((current) => {
      if (current === 'notifications') return 'chat'
      setLastSeenNoticeId(latestNoticeId)
      return 'notifications'
    })
  }

  const openDiff = () => {
    if (!diffOpen) void controller.refreshWorkspaceDiff()
    setDiffOpen(true)
  }

  const toggleDiff = () => {
    if (diffOpen) setDiffOpen(false)
    else openDiff()
  }

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'row', width: '100%', height: '100%', backgroundColor: colors.background, color: colors.text, overflow: 'hidden' }}>
      <WorkbenchSidebar
        state={state}
        controller={controller}
        settingsActive={surface === 'settings'}
        notificationsActive={surface === 'notifications'}
        unreadCount={unreadCount}
        onSettings={() => setSurface((current) => current === 'settings' ? 'chat' : 'settings')}
        onNotifications={toggleNotifications}
      />
      {surface === 'settings' ? (
        <SettingsView state={state} controller={controller} onClose={() => setSurface('chat')} />
      ) : surface === 'notifications' ? (
        <NotificationLedgerView state={state} controller={controller} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, minWidth: 0, height: '100%', backgroundColor: colors.background }}>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, height: '100%' }}>
            <ChatHeader state={state} controller={controller} diffOpen={diffOpen} onToggleDiff={toggleDiff} />
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
              {draft ? (
                <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 25, paddingLeft: 20, paddingRight: 20, paddingBottom: 74 }}>
                  <text style={{ color: colors.text, fontSize: 26, fontWeight: 500, maxWidth: 900, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`What should we build in ${projectName}?`}</text>
                  <Composer state={state} controller={controller} draft />
                </div>
              ) : (
                <>
                  <Transcript state={state} presenters={presenters} onOpenDiff={openDiff} />
                  <Composer state={state} controller={controller} />
                </>
              )}
            </div>
          </div>
          {diffOpen && <DiffPanel diff={state.workspaceDiff} controller={controller} onClose={() => setDiffOpen(false)} />}
        </div>
      )}
      <NotificationToast notices={state.notices} />
    </div>
  )
}
