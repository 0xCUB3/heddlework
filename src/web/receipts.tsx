import { useState } from 'react'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'

export function Receipts({ state }: { state: WorkbenchSnapshot }) {
  const receipts = [...state.receipts].reverse()
  const [open, setOpen] = useState<string | undefined>(undefined)
  if (receipts.length === 0) return <p className="web-meta">No receipts yet</p>
  return (
    <section className="web-receipts">
      <div className="web-composer-row">
        <h3>Receipts</h3>
        <button type="button" onClick={() => void workspaceClient().send({ type: 'clearReceipts', sessionPath: receipts[0]!.sessionPath })}>Clear</button>
      </div>
      {receipts.map((receipt) => (
        <article key={receipt.id} className="web-card">
          <p className="web-meta">Turn {receipt.turn} · {new Date(receipt.completedAt).toLocaleTimeString()} · {receipt.tools.map((tool) => `${tool.name}×${tool.count}`).join(' ') || 'no tools'}</p>
          <ul className="web-list">
            {receipt.files.map((file) => {
              const key = `${receipt.id}:${file.path}`
              return (
                <li key={file.path}>
                  <button type="button" className="web-session" onClick={() => setOpen(open === key ? undefined : key)}>
                    <span className="web-receipt-status">{file.status}</span>
                    <strong>{file.path}</strong>
                    <span className="web-meta">+{file.additions} / -{file.deletions}</span>
                  </button>
                  {open === key ? (
                    file.patch ? (
                      <pre className="web-patch web-patch-wrap">{file.patch.split('\n').map((line, index) => {
                        const kind = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : 'ctx'
                        return <span key={index} className={`web-patch-${kind}`}>{line + '\n'}</span>
                      })}</pre>
                    ) : <p className="web-meta">Patch too large to store</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </article>
      ))}
    </section>
  )
}
