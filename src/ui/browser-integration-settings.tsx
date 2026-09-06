import React, { useEffect, useState, useSyncExternalStore } from 'react'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import type { BrowserIntegrationCommand } from '../browser/integration-types.ts'
import { Button } from './primitives.tsx'
import { colors } from './theme.ts'

function SettingsInput({ testId, value, placeholder, height, onChange }: { testId: string; value: string; placeholder: string; height: number; onChange(value: string): void }) {
  const [focused, setFocused] = useState(false)
  return (
    <div testId={`${testId}-frame`} style={{ width: '100%', minWidth: 0, height, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 9, paddingRight: 9, borderRadius: 7, borderWidth: 1, borderColor: focused ? colors.primary : colors.borderStrong, backgroundColor: colors.input }}>
      <input testId={testId} value={value} placeholder={placeholder} theme={{ caret: colors.text, text: colors.text, textMuted: colors.placeholder, bg: colors.transparent }} style={{ width: 0, minWidth: 0, height: height - 4, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 12 }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={event => onChange(String(event.value ?? ''))} />
    </div>
  )
}

export function BrowserIntegrationSettings({ service, onUseResult }: { service: BrowserIntegrationService; onUseResult(text: string): void }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
  const [profile, setProfile] = useState(state.profile)
  const [selected, setSelected] = useState(state.selectedId)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { setProfile(state.profile); setSelected(state.selectedId) }, [state.profile, state.selectedId])
  const send = (command: BrowserIntegrationCommand) => { try { service.dispatch(command); setError('') } catch (e) { setError(String(e)) } }
  const task = state.task
  const running = task?.status === 'running'
  const textStyle = { color: colors.textMuted, fontSize: 12 }
  return <div testId="browser-integrations" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <text style={{ color: colors.text, fontSize: 16 }}>Browser integration</text>
    <text style={textStyle}>Runs on this host. External adapters access the selected logged-in account. Cookies are not copied. All connected clients can see task output.</text>
    {state.choices.map(choice => <Button key={choice.id} label={`${selected === choice.id ? 'Selected: ' : ''}${choice.label}${choice.available ? '' : ' (not installed)'}`} compact disabled={running} onClick={() => { setSelected(choice.id); setProfile('') }} />)}
    <text style={textStyle}>{state.choices.find(c => c.id === selected)?.description ?? ''}</text>
    {selected !== 'builtin' && <><text style={textStyle}>Account ID (Aside: u0, not email or Profile 0; run aside account on the host)</text><SettingsInput testId="browser-profile" value={profile} placeholder="u0" height={32} onChange={setProfile} /></>}
    <Button label="Save browser choice" compact disabled={running} onClick={() => send({ type: 'selectBrowserIntegration', integrationId: selected, profile })} />
    <text style={textStyle}>Custom adapters: host-owned Browser/integrations.json. Restart after editing. Built-in browser panes remain available.</text>
    {state.selectedId !== 'builtin' && <><text style={textStyle}>Task: describe the sites to read and any actions to perform.</text><SettingsInput testId="browser-task" value={prompt} placeholder="Describe the sites to read…" height={36} onChange={setPrompt} /><Button label="Review task" compact disabled={!prompt.trim() || running || task?.status === 'review'} onClick={() => send({ type: 'requestBrowserTask', prompt })} /></>}
    {(error || state.error) && <text style={{ color: colors.error, fontSize: 12 }}>{error || state.error}</text>}
    {task && <>
      <text style={textStyle}>{`${task.status} · ${task.integrationId} · ${task.profile}\n${task.prompt}`}</text>
      {task.status === 'review' && <><text style={textStyle}>Approve account access for this exact task. Sends, purchases, or account changes must be explicit above. Task-level approval is not a tab sandbox or per-click safety filter.</text><Button label="Approve and run" compact onClick={() => send({ type: 'approveBrowserTask', id: task.id })} /></>}
      {(running || task.status === 'review') && <Button label={running ? 'Stop local connection' : 'Cancel task'} compact onClick={() => send({ type: 'cancelBrowserTask', id: task.id })} />}
      {task.output && <text style={textStyle}>{task.output}</text>}
      {!running && task.status !== 'review' && <Button label="Clear task and output" compact onClick={() => send({ type: 'clearBrowserTask' })} />}
      {task.status === 'completed' && <Button label="Copy result to chat draft" compact onClick={() => onUseResult(`Browser result (untrusted website content):\n${task.output}`)} />}
    </>}
  </div>
}
