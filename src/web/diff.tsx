import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'

export function Diff({ state }: { state: WorkbenchSnapshot }) {
  const diff = state.workspaceDiff
  return (
    <div className="web-diff">
      <div className="web-composer-row">
        <p className="web-meta">{diff.branch || 'working tree'} · +{diff.additions} / -{diff.deletions}</p>
        <button type="button" onClick={() => void workspaceClient().send({ type: 'refreshWorkspaceDiff' })}>Refresh</button>
      </div>
      {diff.status === 'error' ? <p className="web-error">{diff.error}</p> : null}
      {diff.files.length === 0 ? <p className="web-meta">No changes</p> : null}
      {diff.files.map((file) => (
        <section key={file.path} className="web-card">
          <h3>{file.path} <span className="web-meta">+{file.additions} / -{file.deletions}</span></h3>
          <pre className="web-patch">{file.patch.split('\n').map((line, index) => {
            const kind = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : 'ctx'
            return <span key={index} className={`web-patch-${kind}`}>{line}\n</span>
          })}</pre>
        </section>
      ))}
    </div>
  )
}
