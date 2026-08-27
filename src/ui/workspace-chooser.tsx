import React, { useMemo, useState } from 'react'
import { basename, resolve } from 'node:path'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Composer } from './composer.tsx'
import { matchSelectOptions, NativeVirtualList } from './primitives.tsx'
import { Icon } from './icons.tsx'
import { pickWorkspaceDirectory } from './open-external.ts'
import { colors, nativeTheme } from './theme.ts'

interface WorkspaceChoice {
  path: string
  name: string
  current: boolean
}

export function workspaceChoices(state: Pick<WorkbenchState, 'workspacePath' | 'sessions'>): WorkspaceChoice[] {
  const currentPath = resolve(state.workspacePath)
  const paths = new Map<string, string>([[currentPath, basename(currentPath) || currentPath]])
  for (const session of state.sessions) {
    const path = resolve(session.cwd)
    if (!paths.has(path)) paths.set(path, basename(path) || path)
  }
  return [...paths].map(([path, name]) => ({ path, name, current: path === currentPath })).sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

export function DraftWorkspaceChooser({ state, controller }: { state: WorkbenchState; controller: WorkbenchController }) {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const choices = useMemo(() => workspaceChoices(state), [state.sessions, state.workspacePath])
  const current = choices[0]!
  const choicesByPath = useMemo(() => new Map(choices.map((choice) => [choice.path, choice])), [choices])
  const filteredChoices = useMemo(() => matchSelectOptions(choices.map((choice) => ({ value: choice.path, label: choice.name, detail: choice.path })), query).map((option) => choicesByPath.get(option.value)!).filter(Boolean), [choices, choicesByPath, query])
  const projectListHeight = Math.min(210, Math.max(36, filteredChoices.length * 42))
  const closeMenu = () => {
    setOpen(false)
    setQuery('')
  }
  const chooseNewProject = () => {
    if (picking) return
    setPicking(true)
    void pickWorkspaceDirectory().then((path) => {
      if (path) void controller.switchWorkspace(path)
    }).finally(() => {
      setPicking(false)
      closeMenu()
    })
  }
  return (
    <div testId="draft-workspace" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', flexGrow: 1, width: '100%', paddingLeft: 20, paddingRight: 20, paddingBottom: 74 }}>
      <div testId="draft-workspace-stack" style={{ position: 'relative', width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 25, overflow: 'visible' }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', maxWidth: '100%' }}>
          <text style={{ color: colors.text, fontSize: 26, fontWeight: 500 }}>{'What should we build in '}</text>
          <div testId="workspace-chooser-trigger" tabIndex={0} style={{ minWidth: 0, height: 32, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 1, borderColor: open ? colors.primary : colors.textMuted, cursor: 'pointer', hover: { borderColor: colors.text } }} onClick={() => { if (open) closeMenu(); else setOpen(true) }} onKeyDown={(event) => { if (event.key === 'enter') { if (open) closeMenu(); else setOpen(true) } }}>
            <text style={{ color: colors.text, fontSize: 26, lineHeight: 31, fontWeight: 500, maxWidth: 320, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{current.name}</text>
          </div>
          <text style={{ color: colors.text, fontSize: 26, fontWeight: 500 }}>?</text>
        </div>
        <div testId="draft-composer-layer" style={{ width: '100%', display: 'flex' }}>
          <Composer state={state} controller={controller} draft />
        </div>
        {open && (
          <>
          <div testId="workspace-menu-dismiss" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: colors.transparent }} onClick={closeMenu} />
          <div testId="workspace-menu-positioner" style={{ position: 'absolute', top: 38, right: 24, width: 320, display: 'flex', backgroundColor: colors.transparent }}>
            <div testId="workspace-menu" tabIndex={0} style={{ width: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 5, padding: 6, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover, overflow: 'hidden' }}>
              <div style={{ height: 34, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 9, paddingRight: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}>
                <Icon name="search" size={13} color={colors.textFaint} />
                <input testId="workspace-search" value={query} placeholder="Search projects…" autoFocus theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }} style={{ minWidth: 0, flexGrow: 1, height: 30, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 11 }} onChange={(event) => setQuery(String(event.value ?? ''))} />
              </div>
              {filteredChoices.length > 0 ? (
                <NativeVirtualList testId="workspace-project-list" alignment="top" estimatedItemHeight={42} overdraw={84} style={{ width: '100%', height: projectListHeight, minHeight: 0 }}>
                  {filteredChoices.map((choice) => (
                    <div key={choice.path} testId={choice.current ? 'workspace-choice-current' : 'workspace-choice'} tabIndex={choice.current ? -1 : 0} style={{ height: 42, flexShrink: 0, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 10, paddingRight: 10, borderRadius: 8, backgroundColor: choice.current ? colors.raised : colors.transparent, cursor: choice.current ? 'default' : 'pointer', hover: choice.current ? {} : { backgroundColor: colors.hover } }} {...(choice.current ? {} : { onClick: () => { closeMenu(); void controller.switchWorkspace(choice.path) }, onKeyDown: (event: { key?: string }) => { if (event.key === 'enter') { closeMenu(); void controller.switchWorkspace(choice.path) } } })}>
                      <Icon name="folder" size={15} color={choice.current ? colors.textMuted : colors.textFaint} />
                      <text style={{ minWidth: 0, flexGrow: 1, color: colors.text, fontSize: 12, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{choice.name}</text>
                      {choice.current && <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontMono }}>CURRENT</text>}
                    </div>
                  ))}
                </NativeVirtualList>
              ) : (
                <div testId="workspace-search-empty" style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><text style={{ color: colors.textFaint, fontSize: 10 }}>No projects match your search</text></div>
              )}
              <text testId="workspace-search-count" style={{ color: colors.textFaint, fontSize: 9, paddingLeft: 9 }}>{`${filteredChoices.length} of ${choices.length} projects`}</text>
              <div style={{ height: 1, backgroundColor: colors.borderStrong }} />
              <div testId="workspace-new-project" tabIndex={picking ? -1 : 0} style={{ height: 42, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 10, paddingRight: 10, borderRadius: 8, opacity: picking ? 0.55 : 1, cursor: picking ? 'default' : 'pointer', hover: picking ? {} : { backgroundColor: colors.hover } }} onClick={chooseNewProject} onKeyDown={(event) => { if (event.key === 'enter') chooseNewProject() }}>
                <Icon name="folderPlus" size={16} color={colors.textMuted} />
                <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>{picking ? 'Choosing project…' : 'New project'}</text>
              </div>
            </div>
          </div>
          </>
        )}
      </div>
    </div>
  )
}
