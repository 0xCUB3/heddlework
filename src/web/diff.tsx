import { useState } from 'react'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'
import { Receipts } from './receipts.tsx'

export function Diff({ state }: { state: WorkbenchSnapshot }) {
  const diff = state.workspaceDiff
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [wrap, setWrap] = useState(false)
  const file = diff.files.find((entry) => entry.path === selected)
  return (
    <div className="web-diff">
      <div className="web-composer-row">
        <p className="web-meta">{diff.branch || 'working tree'} · +{diff.additions} / -{diff.deletions}</p>
        <button type="button" onClick={() => void workspaceClient().send({ type: 'refreshWorkspaceDiff' })}>Refresh</button>
        {file ? <button type="button" onClick={() => setWrap((value) => !value)}>{wrap ? 'Unwrap' : 'Wrap'}</button> : null}
      </div>
      {diff.status === 'error' ? <p className="web-error">{diff.error}</p> : null}
      {!file ? <Receipts state={state} /> : null}
      {diff.files.length === 0 ? <p className="web-meta">No changes</p> : null}
      {!file ? (
        <ul className="web-list">
          {diff.files.map((entry) => (
            <li key={entry.path}>
              <button type="button" className="web-session" onClick={() => setSelected(entry.path)}>
                <strong>{entry.path}</strong>
                <span className="web-meta">+{entry.additions} / -{entry.deletions}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <section className="web-card">
          <button type="button" onClick={() => setSelected(undefined)}>All files</button>
          <h3>{file.path} <span className="web-meta">+{file.additions} / -{file.deletions}</span></h3>
          <pre className={wrap ? 'web-patch web-patch-wrap' : 'web-patch'}>{file.patch.split('\n').map((line, index) => {
            const kind = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : 'ctx'
            return <span key={index} className={`web-patch-${kind}`}>{line + '\n'}</span>
          })}</pre>
        </section>
      )}
    </div>
  )
}
