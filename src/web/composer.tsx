import { useEffect, useState } from 'react'
import type { ComposerImage } from '../pi/types.ts'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'
import { ArrowUpIcon, BotIcon, ChevronDownIcon, FolderIcon, GitBranchIcon, PaperclipIcon, StopIcon } from './icons.tsx'

export function Composer({ state, hero = false }: { state: WorkbenchSnapshot; hero?: boolean }) {
  const [text, setText] = useState(state.editorText)
  const [menu, setMenu] = useState<'model' | 'thinking' | 'more' | null>(null)
  const streaming = state.session.isStreaming
  const client = workspaceClient()
  const hasInput = Boolean(text.trim() || state.editorImages.length > 0)
  const model = state.session.model?.name ?? state.session.model?.id ?? 'Pi model'
  const branch = state.workspaceDiff.branch || 'workspace'

  useEffect(() => setText(state.editorText), [state.editorText])

  const send = (queue = false): void => {
    if (!text.trim() && state.editorImages.length === 0) {
      if (!queue && state.queue.paused && state.queue.items.length > 0) void client.sendAndReport({ type: 'resumeQueue' })
      return
    }
    void client.send(queue ? { type: 'submit', text, queue: true } : { type: 'submit', text }).then(() => setText(''), (error: unknown) => client.reportError(error))
  }

  return (
    <form
      className={hero ? 'web-composer web-composer-hero' : 'web-composer'}
      onKeyDown={(event) => { if (event.key === 'Escape') setMenu(null) }}
      onSubmit={(event) => {
        event.preventDefault()
        send(false)
      }}
    >
      {state.editorImages.length > 0 && <div className="web-composer-attachments">{state.editorImages.map((image) => <button key={String(image.id)} type="button" className="web-image-chip" onClick={() => void client.sendAndReport({ type: 'removeEditorImage', id: String(image.id) })}>Remove {String(image.fileName)}</button>)}</div>}
      <div className="web-composer-wrap">
        <div className="web-composer-surface" data-testid="composer-surface">
          {menu && <div className="web-composer-menu" role="dialog" aria-label={`${menu} options`}>
            {menu === 'model' && state.models.map((option) => <button type="button" key={`${option.provider}/${option.id}`} onClick={() => { void client.sendAndReport({ type: 'setModel', provider: option.provider, id: option.id }); setMenu(null) }}>{option.name ?? option.id}</button>)}
            {(menu === 'thinking' || menu === 'more') && <label>Thinking<select aria-label="Thinking level" value={state.session.thinkingLevel} onChange={(event) => void client.sendAndReport({ type: 'setThinkingLevel', level: event.target.value as WorkbenchSnapshot['session']['thinkingLevel'] })}>{state.thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>}
            {menu === 'more' && <button type="button" disabled={!hasInput} onClick={() => { send(true); setMenu(null) }}>Queue input</button>}
            {menu === 'more' && state.queue.paused && <button type="button" onClick={() => { void client.sendAndReport({ type: 'resumeQueue' }); setMenu(null) }}>Resume queue</button>}
            <button type="button" onClick={() => setMenu(null)}>Close</button>
          </div>}
          <textarea
            value={text}
            placeholder="Ask for changes, send follow-ups, or attach images"
            onChange={(event) => {
              setText(event.target.value)
              void client.sendAndReport({ type: 'setEditorText', text: event.target.value })
            }}
            onPaste={(event) => {
              const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
              if (files.length === 0) return
              event.preventDefault()
              for (const file of files) void addImage(file)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              send(event.altKey)
            }}
          />
          <div className="web-composer-row web-composer-actions">
            <div className="web-composer-actions-left">
              <button type="button" className="web-composer-control web-model-control" title="Model" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}><BotIcon /> {model}<ChevronDownIcon className="web-chevron" /></button>
              <span className="web-composer-separator" />
              <button type="button" className="web-composer-control" title="Thinking" aria-expanded={menu === 'thinking'} onClick={() => setMenu(menu === 'thinking' ? null : 'thinking')}>{state.session.thinkingLevel}<ChevronDownIcon className="web-chevron" /></button>
              <button type="button" className="web-composer-control web-composer-more" onClick={() => setMenu(menu === 'more' ? null : 'more')} aria-expanded={menu === 'more'} aria-label="Composer options" title="Composer options">…</button>
              {state.queue.items.length > 0 ? <span className="web-queue-count">{state.queue.items.length} queued{state.queue.paused ? ' · paused' : ''}</span> : null}
            </div>
            <div className="web-composer-actions-right">
              <label className="web-attach" title="Attach image" aria-label="Attach image"><PaperclipIcon /><input type="file" accept="image/*" hidden onChange={(event) => { for (const file of event.target.files ?? []) void addImage(file) }} /></label>
              {streaming
                ? <button type="button" className="web-send web-abort" onClick={() => void client.sendAndReport({ type: 'abort' })} aria-label="Stop"><StopIcon /></button>
                : <button type="submit" className="web-send" disabled={!hasInput} aria-label="Send"><ArrowUpIcon /></button>}
            </div>
          </div>
        </div>
        <div className="web-composer-context" data-testid="composer-context-bar">
          <FolderIcon />
          <span className="web-composer-checkout">Local checkout</span>
          <span className="web-composer-context-spacer" />
          <GitBranchIcon />
          <span className="web-composer-branch">{branch}</span>
        </div>
      </div>
    </form>
  )
}

async function addImage(file: File): Promise<void> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of buffer) binary += String.fromCharCode(byte)
  const image: ComposerImage = {
    type: 'image',
    data: btoa(binary),
    mimeType: file.type || 'image/png',
    id: crypto.randomUUID(),
    fileName: file.name || 'paste.png',
    size: file.size,
  }
  await workspaceClient().sendAndReport({ type: 'addEditorImage', image })
}
