import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { SidebarAudit } from './fixtures/sidebar-audit.tsx'

const native = hasNativeTestRenderer ? describe : describe.skip
native('sidebar card hit targets', () => {
  it('opens from padding, title and footer without letting actions open a session', async () => {
    const root = createTestRoot()
    root.render(<SidebarAudit />)
    await Bun.sleep(0)
    root.renderer.flush()
    const app = await connectTest(root.renderer)
    try {
      const box = await app.getByTestId('audit-plain').bounds()
      expect(box.height).toBe(60)
      await app.mouse.click({ x: box.x + 11, y: box.y + box.height - 7 })
      expect(await app.getByTestId('audit-events').textContent()).toBe('open:plain')
      await app.getByTestId('audit-git').getByTestId('sidebar-session-footer').click()
      expect(await app.getByTestId('audit-events').textContent()).toBe('open:plain,open:git')
      const card = app.getByTestId('audit-git').getByTestId('sidebar-session-card-active')
      await card.hover()
      await Bun.sleep(0)
      root.renderer.flush()
      await app.getByTestId('audit-git').getByTestId('sidebar-settle').hover()
      await Bun.sleep(20)
      root.renderer.flush()
      await app.getByTestId('audit-git').getByTestId('sidebar-settle').click()
      expect(await app.getByTestId('audit-events').textContent()).toBe('open:plain,open:git,settle:git')
      await app.getByTestId('audit-git').getByTestId('sidebar-snooze').click()
      expect(await app.getByTestId('audit-events').textContent()).toBe('open:plain,open:git,settle:git,snooze:git')
      await app.getByTestId('snooze-option-0').click()
      expect(await app.getByTestId('audit-events').textContent()).toEndWith('schedule:git')
      await app.getByTestId('audit-short').getByTestId('sidebar-session-open').press('enter')
      expect(await app.getByTestId('audit-events').textContent()).toEndWith('open:short')
      await app.getByTestId('audit-short').getByTestId('sidebar-session-open').press('space')
      expect(await app.getByTestId('audit-events').textContent()).toEndWith('open:short,open:short')
      expect((await app.getByTestId('audit-git').bounds()).height).toBe(78)
      const saved = await app.getByTestId('audit-settled').bounds()
      await app.mouse.click({ x: saved.x + 11, y: saved.y + 3 })
      expect(await app.getByTestId('audit-events').textContent()).toEndWith('open:settled')
      await app.getByTestId('audit-settled').getByTestId('sidebar-wake').click()
      expect(await app.getByTestId('audit-events').textContent()).toEndWith('open:settled,wake:settled')
      await app.getByTestId('audit-git').getByTestId('sidebar-session-open').hover()
      await app.getByTestId('audit-git').getByTestId('sidebar-snooze').click()
      const beforeDismiss = await app.getByTestId('audit-events').textContent()
      await app.mouse.click({ x: saved.x + 40, y: saved.y + 18 })
      expect(await app.getByTestId('audit-events').textContent()).toBe(`${beforeDismiss},snooze:git`)
      await Bun.sleep(200)
      await app.getByTestId('audit-git').getByTestId('sidebar-session-open').hover()
      await app.getByTestId('audit-git').getByTestId('sidebar-snooze').click()
      await app.getByTestId('snooze-dismiss').press('escape')
      await Bun.sleep(200); root.renderer.flush()
      expect(await app.getByTestId('snooze-menu').count()).toBe(0)
    } finally { await app.close(); root.unmount() }
  })
})
