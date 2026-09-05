#!/usr/bin/env bun
/** Native GPUix layout probe against the current main-app UI. Not part of CI. */
import React from 'react'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../../src/pi/demo-transport.ts'
import { PiSessionCatalog } from '../../src/pi/session-catalog.ts'
import { WorkbenchController } from '../../src/workbench/controller.ts'
import { WorkbenchApp } from '../../src/ui/app.tsx'
import uiContract from '../../src/workbench/ui-contract.json'
import { ThemeManager } from '../../src/ui/theme-manager.ts'
import { loadWorkspaceDiff } from '../../src/workspace/git-diff.ts'
import { createCoreUiExtension } from '../../src/ui/core-extension.tsx'
import { WorkbenchUiRegistry } from '../../src/ui/extensions.ts'
import { SPRING_SETTLE_MS } from '../../src/ui/motion.ts'
import { resolveResponsiveLayout } from '../../src/ui/responsive.tsx'

const OUT = resolve(import.meta.dir, 'ui-parity-native')

type Rect = { x: number; y: number; width: number; height: number }
type ThemeName = 'light' | 'dark'
type SceneSet = 'full' | 'lite'

function roundRect(r: Rect): Rect {
  return {
    x: Math.round(r.x * 10) / 10,
    y: Math.round(r.y * 10) / 10,
    width: Math.round(r.width * 10) / 10,
    height: Math.round(r.height * 10) / 10,
  }
}

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'gpuix-layout-audit-'))
  writeFileSync(join(workspace, 'README.md'), '# audit\n')
  const run = (cmd: string[]) => {
    const result = Bun.spawnSync(cmd, { cwd: workspace, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  run(['git', 'init', '-q'])
  run(['git', 'add', '.'])
  run(['git', '-c', 'user.name=Audit', '-c', 'user.email=audit@test', 'commit', '-qm', 'seed'])
  run(['git', 'branch', '-M', 'main'])
  writeFileSync(join(workspace, 'README.md'), '# audit\n\nchanged\n')
  return workspace
}

function deps() {
  return {
    sessionCatalog: new PiSessionCatalog({ scope: 'cwd' }),
    workspaceDiff: { load: loadWorkspaceDiff },
  }
}

function uiRegistry(controller: WorkbenchController) {
  const registry = new WorkbenchUiRegistry()
  registry.register(createCoreUiExtension(controller))
  return registry
}

async function waitConnected(controller: WorkbenchController, root: ReturnType<typeof createTestRoot>): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    root.renderer.flush()
    if (controller.getSnapshot().connection === 'connected') return
    await Bun.sleep(40)
  }
}

async function settle(root: ReturnType<typeof createTestRoot>, ms = 120): Promise<void> {
  root.renderer.flush()
  await Bun.sleep(ms)
  root.renderer.flush()
}

async function ensureSidebarOpen(
  automation: Awaited<ReturnType<typeof connectTest>>,
  root: ReturnType<typeof createTestRoot>,
  width: number,
): Promise<void> {
  if (!resolveResponsiveLayout(width).navigationOverlay) return
  if ((await automation.getByTestId('sidebar-settings').count()) > 0) return
  const toggle = automation.getByTestId('toggle-left-sidebar')
  if ((await toggle.count()) === 0) return
  await toggle.click()
  await settle(root, SPRING_SETTLE_MS)
}

async function clickTestId(
  automation: Awaited<ReturnType<typeof connectTest>>,
  root: ReturnType<typeof createTestRoot>,
  width: number,
  testId: string,
): Promise<void> {
  if (testId.startsWith('sidebar-')) await ensureSidebarOpen(automation, root, width)
  const locator = automation.getByTestId(testId)
  if ((await locator.count()) === 0) throw new Error(`Missing testId for layout audit: ${testId}`)
  await locator.click()
  await settle(root, 80)
}

async function bounds(automation: Awaited<ReturnType<typeof connectTest>>, testId: string): Promise<Rect | null> {
  if ((await automation.getByTestId(testId).count()) === 0) return null
  try {
    return roundRect(await automation.getByTestId(testId).bounds())
  } catch {
    return null
  }
}

async function style(root: ReturnType<typeof createTestRoot>, testId: string, key: string): Promise<string | undefined> {
  const node = root.renderer.findByTestId(testId)
  if (!node?.style) return undefined
  const v = (node.style as Record<string, unknown>)[key]
  return v === undefined ? undefined : String(v)
}

function near(actual: number | undefined, expected: number, tol: number): boolean {
  return actual !== undefined && Math.abs(actual - expected) <= tol
}

function check(failures: string[], label: string, ok: boolean, detail: string): void {
  if (!ok) failures.push(`${label}: ${detail}`)
}

async function captureScenario(options: {
  label: string
  width: number
  height: number
  theme: ThemeName
  scenes: SceneSet
}): Promise<Record<string, unknown>> {
  const { label, width, height, theme, scenes } = options
  const workspace = createWorkspace()
  const controller = new WorkbenchController(new DemoTransport(), workspace, deps())
  const root = createTestRoot({ width, height })
  const themeManager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => theme })
  root.render(
    <WorkbenchApp controller={controller} presenters={new Map()} ui={uiRegistry(controller)} themeManager={themeManager} />,
  )
  await controller.start()
  await waitConnected(controller, root)
  await settle(root, 80)
  const automation = await connectTest(root.renderer)
  const failures: string[] = []
  const layout = resolveResponsiveLayout(width)
  const shot = (name: string) => {
    const path = resolve(OUT, `${label}-${name}.png`)
    root.renderer.captureScreenshot(path)
    return path
  }

  const report: Record<string, unknown> = {
    label,
    viewport: { width, height },
    theme,
    contract: uiContract.layout,
    typography: uiContract.typography,
    responsive: {
      viewportClass: layout.viewportClass,
      navigationOverlay: layout.navigationOverlay,
      panelOverlay: layout.panelOverlay,
      contentGutter: layout.contentGutter,
      composerGutter: layout.composerGutter,
    },
    scenes: {} as Record<string, unknown>,
    interactions: [] as string[],
    failures,
  }

  const draftBounds = {
    workbenchRoot: await bounds(automation, 'workbench-root'),
    leftSidebarHost: await bounds(automation, 'left-sidebar-host'),
    sidebar: await bounds(automation, 'sidebar'),
    sidebarBrand: await bounds(automation, 'sidebar-brand'),
    chatHeader: await bounds(automation, 'chat-breadcrumb'),
    draftWorkspace: await bounds(automation, 'draft-workspace'),
    draftStack: await bounds(automation, 'draft-workspace-stack'),
    composerSurface: await bounds(automation, 'composer-surface'),
    composerTextarea: await bounds(automation, 'composer'),
    composerContext: await bounds(automation, 'composer-context-bar'),
    send: await bounds(automation, 'send'),
  }
  const draftStyles = {
    composerSurfaceRadius: await style(root, 'composer-surface', 'borderRadius'),
    composerFontSize: await style(root, 'composer', 'fontSize'),
    composerLineHeight: await style(root, 'composer', 'lineHeight'),
    sidebarBackground: await style(root, 'sidebar', 'backgroundColor'),
    workbenchBackground: await style(root, 'workbench-root', 'backgroundColor'),
    connected: controller.getSnapshot().connection,
  }
  ;(report.scenes as Record<string, unknown>).draftEmpty = {
    screenshot: shot('draft-empty'),
    bounds: draftBounds,
    styles: draftStyles,
  }

  const rootBox = draftBounds.workbenchRoot
  check(failures, `${label} root width`, near(rootBox?.width, width, 1), `width ${rootBox?.width} != ${width}`)
  check(failures, `${label} root height`, near(rootBox?.height, height, 1), `height ${rootBox?.height} != ${height}`)
  if (!layout.navigationOverlay) {
    check(failures, `${label} sidebar width`, near(draftBounds.leftSidebarHost?.width, uiContract.layout.sidebarWidth, 2), `sidebar ${draftBounds.leftSidebarHost?.width}`)
    check(failures, `${label} brand height`, near(draftBounds.sidebarBrand?.height, uiContract.layout.headerHeight, 2), `brand ${draftBounds.sidebarBrand?.height}`)
  } else {
    check(failures, `${label} overlay hides docked sidebar`, draftBounds.leftSidebarHost === null, 'left-sidebar-host still mounted')
  }
  check(failures, `${label} composer radius`, draftStyles.composerSurfaceRadius === '22', `radius ${draftStyles.composerSurfaceRadius}`)
  check(failures, `${label} composer font`, draftStyles.composerFontSize === '14', `fontSize ${draftStyles.composerFontSize}`)
  check(failures, `${label} composer lineHeight`, draftStyles.composerLineHeight === '21', `lineHeight ${draftStyles.composerLineHeight}`)
  check(failures, `${label} send size`, near(draftBounds.send?.width, 34, 1) && near(draftBounds.send?.height, 34, 1), `send ${JSON.stringify(draftBounds.send)}`)
  check(failures, `${label} composer height`, near(draftBounds.composerSurface?.height, 148, 8), `composer h ${draftBounds.composerSurface?.height}`)
  if (draftBounds.composerSurface && rootBox) {
    check(failures, `${label} composer inside canvas`, draftBounds.composerSurface.x >= -1 && draftBounds.composerSurface.x + draftBounds.composerSurface.width <= rootBox.width + 1, JSON.stringify(draftBounds.composerSurface))
  }
  if (!layout.mobile) {
    check(failures, `${label} draft stack width`, near(draftBounds.draftStack?.width, uiContract.layout.contentMaxWidth, 2), `stack ${draftBounds.draftStack?.width}`)
  }
  check(failures, `${label} connected`, draftStyles.connected === 'connected', `connection ${draftStyles.connected}`)

  if (scenes === 'full' && (await automation.getByTestId('model-picker').count()) > 0) {
    await clickTestId(automation, root, width, 'model-picker')
    ;(report.interactions as string[]).push('opened-model-picker')
    ;(report.scenes as Record<string, unknown>).modelPicker = { screenshot: shot('model-picker') }
    if ((await automation.getByTestId('model-picker').count()) > 0) {
      await clickTestId(automation, root, width, 'model-picker')
    }
    await settle(root, 80)
  }

  await controller.submit('Layout audit ping')
  for (let i = 0; i < 80; i += 1) {
    root.renderer.flush()
    const snap = controller.getSnapshot()
    if (!snap.session.isStreaming && snap.messages.some((m) => m.role === 'assistant')) break
    await Bun.sleep(50)
  }
  await settle(root, 80)
  const activeBounds = {
    chatHeader: await bounds(automation, 'chat-breadcrumb'),
    transcriptList: await bounds(automation, 'transcript-list'),
    composerSurface: await bounds(automation, 'composer-surface'),
    composerContext: await bounds(automation, 'composer-context-bar'),
  }
  ;(report.scenes as Record<string, unknown>).activeChat = {
    screenshot: shot('chat-active'),
    bounds: activeBounds,
    streaming: controller.getSnapshot().session.isStreaming,
    assistantTurns: controller.getSnapshot().messages.filter((m) => m.role === 'assistant').length,
  }
  check(failures, `${label} assistant turn`, controller.getSnapshot().messages.some((m) => m.role === 'assistant'), 'no assistant message')
  if (activeBounds.composerSurface && rootBox) {
    check(failures, `${label} active composer visible`, activeBounds.composerSurface.y + 40 < height, `composer y ${activeBounds.composerSurface.y}`)
  }

  await clickTestId(automation, root, width, 'sidebar-settings')
  await settle(root, SPRING_SETTLE_MS)
  const settingsBounds = {
    settingsView: await bounds(automation, 'settings-view'),
    settingsGlobal: await bounds(automation, 'settings-global'),
    settingsScroll: await bounds(automation, 'settings-scroll'),
    sidebar: await bounds(automation, 'sidebar'),
  }
  ;(report.scenes as Record<string, unknown>).settings = {
    screenshot: shot('settings'),
    bounds: settingsBounds,
    settingsMaxWidthStyle: await style(root, 'settings-global', 'maxWidth'),
  }
  check(failures, `${label} settings view`, settingsBounds.settingsView !== null, 'settings-view missing after sidebar-settings')
  check(failures, `${label} settings max width`, (await style(root, 'settings-global', 'maxWidth')) === String(uiContract.layout.settingsMaxWidth), `maxWidth ${await style(root, 'settings-global', 'maxWidth')}`)
  if (!layout.navigationOverlay) {
    check(failures, `${label} settings keeps sidebar`, settingsBounds.sidebar !== null, 'sidebar gone on desktop settings')
  }
  if (scenes === 'full' && (await automation.getByTestId('settings-done').count()) > 0) {
    await clickTestId(automation, root, width, 'settings-done')
    await settle(root, SPRING_SETTLE_MS)
    ;(report.interactions as string[]).push('closed-settings')
  } else if ((await automation.getByTestId('sidebar-session-active').count()) > 0 || layout.navigationOverlay) {
    await clickTestId(automation, root, width, 'sidebar-session-active')
    await settle(root, SPRING_SETTLE_MS)
  }

  if (scenes === 'full') {
    await settle(root, SPRING_SETTLE_MS)
    if ((await automation.getByTestId('sidebar-session-active').count()) === 0 && layout.navigationOverlay) {
      await ensureSidebarOpen(automation, root, width)
    }
    if ((await automation.getByTestId('toggle-diff').count()) > 0) {
      await clickTestId(automation, root, width, 'toggle-diff')
      await settle(root, SPRING_SETTLE_MS + 80)
      if ((await automation.getByTestId('diff-panel').count()) === 0 && (await automation.getByTestId('right-panel-host').count()) === 0) {
        await clickTestId(automation, root, width, 'toggle-diff')
        await settle(root, SPRING_SETTLE_MS + 80)
      }
      const rightBounds = {
        rightPanelHost: await bounds(automation, 'right-panel-host'),
        diffPanel: await bounds(automation, 'diff-panel'),
        rightPanelHeader: await bounds(automation, 'right-panel-header'),
        workbenchMain: await bounds(automation, 'workbench-main'),
      }
      ;(report.scenes as Record<string, unknown>).rightDiffPanel = {
        screenshot: shot('right-diff'),
        bounds: rightBounds,
      }
      check(failures, `${label} diff panel`, rightBounds.diffPanel !== null || rightBounds.rightPanelHost !== null, 'diff panel missing')
      if (!layout.panelOverlay && rightBounds.rightPanelHost) {
        const mainWidth = width - (layout.navigationOverlay ? 0 : uiContract.layout.sidebarWidth)
        const expected = Math.min(mainWidth, Math.max(420, Math.floor(mainWidth * 0.44)))
        check(failures, `${label} right panel width`, near(rightBounds.rightPanelHost.width, expected, 8), `right ${rightBounds.rightPanelHost.width} expected ${expected}`)
      }
      ;(report.interactions as string[]).push('opened-diff')
    }
  }

  await automation.close()
  root.unmount()
  themeManager.dispose()
  await controller.dispose()
  return report
}

async function main() {
  if (!hasNativeTestRenderer) {
    console.log(JSON.stringify({ ok: false, reason: 'hasNativeTestRenderer=false', outDir: OUT }, null, 2))
    process.exit(0)
  }
  mkdirSync(OUT, { recursive: true })
  const viewports = [
    await captureScenario({ label: 'desktop-1440x900', width: 1440, height: 900, theme: 'light', scenes: 'full' }),
    await captureScenario({ label: 'desktop-1440x900-dark', width: 1440, height: 900, theme: 'dark', scenes: 'lite' }),
    await captureScenario({ label: 'desktop-1440x500', width: 1440, height: 500, theme: 'light', scenes: 'lite' }),
    await captureScenario({ label: 'ipad-1180x820', width: 1180, height: 820, theme: 'light', scenes: 'full' }),
    await captureScenario({ label: 'tablet-1024x768', width: 1024, height: 768, theme: 'light', scenes: 'lite' }),
    await captureScenario({ label: 'phone-390x844', width: 390, height: 844, theme: 'light', scenes: 'full' }),
    await captureScenario({ label: 'phone-390x844-dark', width: 390, height: 844, theme: 'dark', scenes: 'lite' }),
    await captureScenario({ label: 'phone-390x500', width: 390, height: 500, theme: 'light', scenes: 'lite' }),
  ]
  const failures = viewports.flatMap((viewport) => viewport.failures as string[])
  const payload = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    outDir: OUT,
    nativeSource: 'src/ui + src/workbench/ui-contract.json',
    reference: 'Current main GPUix workbench (src/ui), not T3 Code',
    failures,
    viewports,
  }
  const jsonPath = resolve(OUT, 'geometry.json')
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`)
  writeFileSync(resolve(OUT, 'failures.json'), `${JSON.stringify({ ok: payload.ok, failures }, null, 2)}\n`)
  console.log(jsonPath)
  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
}

await main()
