import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { groupWorkItems, projectTranscriptRows } from '../src/ui/transcript-projection.ts'
import { allProjectionSnapshots, groupingCases, snapshotCase } from './fixtures/transcript-projection-cases.ts'

const fixturePath = resolve(import.meta.dir, 'fixtures/transcript-projection.json')

describe('transcript projection fixtures', () => {
  it('writes a cross-language snapshot of grouping and row ids', () => {
    const payload = {
      cases: groupingCases.map((entry) => ({
        name: entry.name,
        isStreaming: entry.isStreaming === true,
        expanded: entry.expanded === true,
        timeline: entry.timeline,
        expected: snapshotCase(entry),
      })),
    }
    mkdirSync(resolve(import.meta.dir, 'fixtures'), { recursive: true })
    writeFileSync(fixturePath, `${JSON.stringify(payload, null, 2)}\n`)
    const snapshots = allProjectionSnapshots()
    expect(snapshots.map((item) => item.name)).toEqual(groupingCases.map((item) => item.name))
    expect(snapshots[0]?.rowKinds).toEqual(['timeline-item', 'trace-header', 'trace-files', 'timeline-item'])
    expect(snapshots[1]?.liveWorkTraceId).toBe('work-trace-after-user')
    expect(snapshots[2]?.groupedKinds).toEqual(['user', 'work-trace', 'assistant'])
    expect(snapshots.map((item) => item.name)).toEqual([
      'collapsed-work',
      'live-boundary',
      'fold-intermediate-assistants',
      'compaction-standalone',
      'notices-grouped',
      'tool-only',
      'thinking-only',
      'error-tool',
      'abort-status',
      'stream-handoff',
    ])
    for (const snapshot of snapshots) {
      expect(new Set(snapshot.rowIds).size).toBe(snapshot.rowIds.length)
    }
  })

  it('projects a 200-turn synthetic session in well under 50ms on this host', () => {
    const timeline = Array.from({ length: 200 }, (_, index) => [
      { id: `u${index}`, kind: 'user' as const, text: `Prompt ${index}`, images: [] },
      { id: `t${index}`, kind: 'thinking' as const, text: 'Plan' },
      { id: `tool${index}`, kind: 'tool' as const, tool: { id: `tool${index}`, name: 'read', status: 'complete' as const, isError: false } },
      { id: `a${index}`, kind: 'assistant' as const, text: `Answer ${index}` },
    ]).flat()
    const started = performance.now()
    const grouped = groupWorkItems(timeline)
    const rows = projectTranscriptRows(grouped, new Set(), new Map())
    const elapsed = performance.now() - started
    expect(grouped.filter((item) => item.kind === 'work-trace')).toHaveLength(200)
    expect(rows.length).toBeGreaterThan(400)
    expect(elapsed).toBeLessThan(50)
  })
})
