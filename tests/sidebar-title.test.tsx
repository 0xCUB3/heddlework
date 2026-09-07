import React, { useState } from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { SessionRow } from '../src/ui/sidebar-session-row.tsx'
import { colors } from '../src/ui/theme.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const session: PiSessionSummary = {
  id: 'title-thread',
  path: '/tmp/title-thread.jsonl',
  cwd: '/tmp/heddlework',
  title: 'Fix login redirect',
  firstMessage: 'Fix login redirect',
  messageCount: 2,
  createdAt: 1,
  modifiedAt: Date.now(),
}

function TitleRowFixture({
  active = true,
  titleGenerating = false,
  onRegenerate,
}: {
  active?: boolean
  titleGenerating?: boolean
  onRegenerate(path: string): void
}) {
  const [moreOpen, setMoreOpen] = useState(true)
  return (
    <div testId="title-row-fixture" style={{ width: 280, height: 400, backgroundColor: colors.sidebar }}>
      <SessionRow
        sidebarWidth={280}
        session={session}
        projectName="heddlework"
        active={active}
        running={false}
        disabled={false}
        lifecycle="active"
        snoozeOpen={false}
        moreOpen={moreOpen}
        titleGenerating={titleGenerating}
        onClick={() => undefined}
        onSettle={() => undefined}
        onWake={() => undefined}
        onSnooze={() => undefined}
        onSchedule={() => undefined}
        onMore={() => setMoreOpen((open) => !open)}
        onAction={(id) => {
          if (id === 'regenerate-title') onRegenerate(session.path)
        }}
      />
    </div>
  )
}

describeNative('sidebar thread titles', () => {
  it('regenerates the current thread title from the row menu', async () => {
    const paths: string[] = []
    const root = createTestRoot({ width: 280, height: 400 })
    root.render(<TitleRowFixture onRegenerate={(path) => paths.push(path)} />)
    const automation = await connectTest(root.renderer)
    try {
      await Bun.sleep(0)
      root.renderer.flush()
      await automation.getByTestId('sidebar-regenerate-title').click()
      expect(paths).toEqual(['/tmp/title-thread.jsonl'])
    } finally {
      await automation.close()
      root.unmount()
    }
  })

  it('shows a generating indicator and keeps regenerate disabled', async () => {
    const paths: string[] = []
    const root = createTestRoot({ width: 280, height: 400 })
    root.render(<TitleRowFixture titleGenerating onRegenerate={(path) => paths.push(path)} />)
    const automation = await connectTest(root.renderer)
    try {
      await Bun.sleep(0)
      root.renderer.flush()
      expect(await automation.getByTestId('sidebar-title-generating').count()).toBe(1)
      expect(root.renderer.findByTestId('sidebar-session-title')?.style.opacity).toBe(0.65)
      await automation.getByTestId('sidebar-regenerate-title').click()
      expect(paths).toEqual([])
    } finally {
      await automation.close()
      root.unmount()
    }
  })
})
