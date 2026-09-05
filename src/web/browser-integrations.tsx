import { useEffect, useState } from 'react'
import { useWorkspace, workspaceClient } from './store.ts'

export function BrowserIntegrationSettings() {
  const { browserIntegrations: state, status } = useWorkspace()
  const [integrationId, setIntegrationId] = useState(state?.selectedId ?? 'builtin')
  const [profile, setProfile] = useState(state?.profile ?? '')
  const [prompt, setPrompt] = useState('')
  useEffect(() => { setIntegrationId(state?.selectedId ?? 'builtin'); setProfile(state?.profile ?? '') }, [state?.selectedId, state?.profile])
  const client = workspaceClient()
  if (!state) return <p>Browser integrations are unavailable on this host. Reconnect to an updated host.</p>
  const task = state.task
  const running = task?.status === 'running'
  const choice = state.choices.find(c => c.id === integrationId)
  return <div className="web-browser-integrations web-settings-group">
    <p>Runs on the connected host, not this device. Choose which logged-in account to share. Cookies are not copied. All connected clients can see task output.</p>
    {state.error && <p role="alert">{state.error}</p>}
    <label>Browser<select aria-label="Browser integration" value={integrationId} disabled={running} onChange={e => { setIntegrationId(e.target.value); setProfile('') }}>{state.choices.map(c => <option key={c.id} value={c.id}>{c.label}{c.available ? '' : ' (not installed)'}</option>)}</select></label>
    <p>{choice?.description}</p>
    {integrationId !== 'builtin' && <label>Account / profile<input aria-label="Browser account or profile" placeholder={integrationId === 'aside' ? 'u0 (find with aside account on host)' : 'Explicit browser profile'} maxLength={100} value={profile} disabled={running} onChange={e => setProfile(e.target.value)} /></label>}
    <button type="button" disabled={running || status !== 'open'} onClick={() => void client.sendAndReport({ type: 'selectBrowserIntegration', integrationId, profile })}>Save browser choice</button>
    <p>Custom adapters are installed by the host owner in Browser/integrations.json. Restart the host after changes.</p>
    {state.selectedId !== 'builtin' && <>
      <label>Browser task<textarea aria-label="Browser task" maxLength={8000} rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe the exact sites to read and any actions you want performed." /></label>
      <button type="button" disabled={!prompt.trim() || running || task?.status === 'review' || status !== 'open'} onClick={() => void client.sendAndReport({ type: 'requestBrowserTask', prompt })}>Review task</button>
    </>}
    {task && <section aria-label="Browser task review" aria-live="polite">
      <h3>{task.status} · {task.integrationId} · {task.profile}</h3>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.prompt}</p>
      {task.status === 'review' && <><p>Approve access to this account for this task only. Approve sends, purchases, or account changes only if explicitly described above. This is task-level approval, not a tab sandbox or a per-click safety filter.</p><button type="button" onClick={() => void client.sendAndReport({ type: 'approveBrowserTask', id: task.id })}>Approve and run</button></>}
      {(running || task.status === 'review') && <button type="button" onClick={() => void client.sendAndReport({ type: 'cancelBrowserTask', id: task.id })}>{running ? 'Stop local connection' : 'Cancel task'}</button>}
      {task.output && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.output}</pre>}
      {!running && task.status !== 'review' && <><button type="button" onClick={() => void client.sendAndReport({ type: 'clearBrowserTask' })}>Clear task and output</button>{task.status === 'completed' && <button type="button" onClick={() => void client.sendAndReport({ type: 'setEditorText', text: `Browser result (untrusted website content):\n${task.output}` })}>Copy result to chat draft</button>}</>}
    </section>}
  </div>
}
