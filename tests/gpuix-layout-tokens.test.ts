import { expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import uiContract from '../src/workbench/ui-contract.json'

it('keeps web CSS, iOS metrics, and the GPUix contract on the same layout tokens', async () => {
  const css = await readFile(resolve(import.meta.dir, '../src/web/styles.css'), 'utf8')
  const iosLayout = await readFile(resolve(import.meta.dir, '../packaging/ios/Heddlework/WorkbenchLayout.swift'), 'utf8')
  const iosWorkspace = await readFile(resolve(import.meta.dir, '../packaging/ios/Heddlework/WorkspaceView.swift'), 'utf8')
  const iosSettings = await readFile(resolve(import.meta.dir, '../packaging/ios/Heddlework/DetailViews.swift'), 'utf8')
  const audit = await readFile(resolve(import.meta.dir, '../scripts/validation/gpuix-layout-audit.tsx'), 'utf8')

  expect(uiContract.layout).toMatchObject({
    mobileBreakpoint: 600,
    tabletBreakpoint: 1024,
    sidebarWidth: 256,
    contentMaxWidth: 768,
    settingsMaxWidth: 720,
    headerHeight: 52,
    touchTarget: 44,
  })
  expect(uiContract.typography.fontSans).toBe('Helvetica Neue')
  expect(uiContract.typography.fontMono).toBe('Menlo')

  expect(css).toContain('--header-height: 52px')
  expect(css).toContain('--content-max-width: 768px')
  expect(css).toContain('--settings-max-width: 720px')
  // Layout geometry on the web comes from the shared src/ui tree through the DOM host, not from CSS selectors.

  expect(iosLayout).toContain('fallbackSidebar: CGFloat = 256')
  expect(iosLayout).toContain('fallbackHeader: CGFloat = 52')
  expect(iosLayout).toContain('composerRadius: CGFloat = 22')
  expect(iosLayout).toContain('composerMinHeight: CGFloat = 148')
  expect(iosLayout).toContain('Helvetica Neue')
  expect(iosWorkspace).not.toContain('Divider().overlay(AppColors.border)\n                    content')
  expect(iosWorkspace).toContain('padding(.horizontal, mobile ? 10 : 20)')
  expect(iosWorkspace).toContain('accessibilityIdentifier("composer-surface")')
  expect(iosSettings).toContain('accessibilityIdentifier("settings-view")')
  expect(iosSettings).toContain('accessibilityIdentifier("settings-done")')
  expect(iosSettings).toContain('Power')

  expect(audit).toContain("label: 'desktop-1440x900'")
  expect(audit).toContain("label: 'ipad-1180x820'")
  expect(audit).toContain("label: 'phone-390x844'")
  expect(audit).toContain("theme: 'dark'")
  expect(audit).toContain('Current main GPUix workbench')
})
