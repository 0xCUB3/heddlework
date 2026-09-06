import { describe, expect, it } from 'bun:test'
import { applySnapshotPatch, type WorkbenchSnapshot } from '../src/protocol/index.ts'
import type { TranscriptProjectionRow } from '../src/ui/transcript-projection.ts'
import { WorkspaceClient } from '../src/web/client.ts'
import { projectWorkspaceRows } from '../src/web/rows.ts'
import {
  ALPHA_LATEST,
  BETA_LATEST,
  startLongSessionHost,
} from './helpers/long-session-host.ts'

function waitFor(client: WorkspaceClient, predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for host snapshot')), timeoutMs)
    const unsubscribe = client.subscribe(() => {
      if (!predicate()) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

function assistantTexts(rows: TranscriptProjectionRow[]): string[] {
  const texts: string[] = []
  for (const row of rows) {
    if (row.kind !== 'timeline-item' || row.item.kind !== 'assistant') continue
    texts.push(row.item.text)
  }
  return texts
}

function latestText(state: WorkbenchSnapshot | undefined): string {
  const messages = state?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    const text = message.content?.find((block) => block.type === 'text')?.text
    if (text) return text
  }
  return ''
}

describe('host-backed long transcript', () => {
  it('opens the latest page, groups work, switches sessions, and reconnects without duplicate rows', async () => {
    const fixture = await startLongSessionHost()
    const client = new WorkspaceClient()
    try {
      const started = performance.now()
      client.connect(fixture.host.url, fixture.host.token)
      await waitFor(client, () => client.getSnapshot().status === 'open' && Boolean(client.getSnapshot().state?.messages?.length))
      const openMs = performance.now() - started
      const first = client.getSnapshot().state!
      expect(openMs).toBeLessThan(4_000)
      expect(latestText(first)).toBe(ALPHA_LATEST)
      expect(first.messagesHasOlder).toBe(true)

      const rows = projectWorkspaceRows(first)
      const ids = rows.map((row) => row.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(rows.some((row) => row.kind === 'trace-header')).toBe(true)
      expect(assistantTexts(rows).at(-1)).toBe(ALPHA_LATEST)

      if (first.messagesHasOlder) {
        const beforeLoad = first.messages[0]?.content
        await client.send({ type: 'loadEarlierMessages' })
        await waitFor(client, () => (client.getSnapshot().state?.messages.length ?? 0) > first.messages.length)
        const afterLoad = client.getSnapshot().state!
        expect(latestText(afterLoad)).toBe(ALPHA_LATEST)
        expect(afterLoad.messages[0]?.content).not.toBe(beforeLoad)
      }

      await client.send({ type: 'switchSession', path: fixture.betaPath })
      await waitFor(client, () => latestText(client.getSnapshot().state) === BETA_LATEST)
      const beta = client.getSnapshot().state!
      expect(beta.session.sessionFile).toBe(fixture.betaPath)
      const betaRows = projectWorkspaceRows(beta)
      expect(new Set(betaRows.map((row) => row.id)).size).toBe(betaRows.length)
      expect(assistantTexts(betaRows).at(-1)).toBe(BETA_LATEST)

      client.disconnect()
      client.connect(fixture.host.url, fixture.host.token)
      await waitFor(client, () => latestText(client.getSnapshot().state) === BETA_LATEST || latestText(client.getSnapshot().state) === ALPHA_LATEST)
      const reconnected = projectWorkspaceRows(client.getSnapshot().state!)
      expect(new Set(reconnected.map((row) => row.id)).size).toBe(reconnected.length)
    } finally {
      client.disconnect()
      await fixture.close()
    }
  }, 20_000)

  it('does not keep removed live rows after a snapshot patch', () => {
    const next = applySnapshotPatch(
      { liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'partial' }] }, liveTools: [{ id: 't', name: 'read', status: 'running', isError: false }] } as WorkbenchSnapshot,
      { version: 1, changed: { liveTools: [] }, removed: ['liveAssistant'] },
    )
    expect(next.liveAssistant).toBeUndefined()
    expect(next.liveTools).toEqual([])
  })
})
