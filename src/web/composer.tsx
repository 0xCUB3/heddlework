import { useState } from 'react'
import type { ComposerImage } from '../pi/types.ts'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'

export function Composer({ state }: { state: WorkbenchSnapshot }) {
  const [text, setText] = useState(state.editorText)
  const streaming = state.session.isStreaming
  const client = workspaceClient()

  return (
    <form
      className="web-composer"
      onSubmit={(event) => {
        event.preventDefault()
        const next = text.trim()
        if (!next) return
        void client.send({ type: 'submit', text: next }).then(() => setText(''))
      }}
    >
      <textarea
        value={text}
        placeholder="Message the workspace"
        onChange={(event) => {
          setText(event.target.value)
          void client.send({ type: 'setEditorText', text: event.target.value })
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
          if (files.length === 0) return
          event.preventDefault()
          for (const file of files) void addImage(file)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          if (event.shiftKey) return
          event.preventDefault()
          if (event.altKey) {
            void client.send({ type: 'queueInput', text })
            setText('')
            return
          }
          if (text.trim()) void client.send({ type: 'submit', text }).then(() => setText(''))
        }}
      />
      <div className="web-composer-row">
        {state.editorImages.map((image) => (
          <button key={String(image.id)} type="button" onClick={() => void client.send({ type: 'removeEditorImage', id: String(image.id) })}>{String(image.fileName)}</button>
        ))}
        {streaming
          ? <button type="button" onClick={() => void client.send({ type: 'abort' })}>Abort</button>
          : <button type="submit">Send</button>}
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
  await workspaceClient().send({ type: 'addEditorImage', image })
}
