import React from 'react'
import { expect, it } from 'bun:test'
import { mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { BrowserIntegrationService } from '../src/browser/integrations.ts'
import { BrowserIntegrationSettings } from '../src/ui/browser-integration-settings.tsx'
import { applyResolvedTheme, colors, darkColors, lightColors } from '../src/ui/theme.ts'

const testNative = hasNativeTestRenderer ? it : it.skip

function asideFixture() {
  return new BrowserIntegrationService({ adapters: [{ choice: { id: 'aside', label: 'Aside', available: true, description: 'Fixture account' }, run: async () => {} }] })
}

function frameStyle(root: ReturnType<typeof createTestRoot>, testId: string) {
  return root.renderer.findByTestId(`${testId}-frame`)?.style
}

function assertInputChrome(root: ReturnType<typeof createTestRoot>, palette: typeof colors, testId: string, height: number) {
  const frame = root.renderer.findByTestId(`${testId}-frame`)
  expect(frame).toBeDefined()
  expect(frameStyle(root, testId)).toMatchObject({
    height,
    borderWidth: 1,
    borderRadius: 7,
    paddingLeft: 9,
    paddingRight: 9,
    borderColor: palette.borderStrong,
    backgroundColor: palette.input,
  })
  const input = root.renderer.findByTestId(testId)
  expect(input?.style.borderWidth).toBe(0)
  expect(input?.style.backgroundColor).toBe(palette.transparent)
  expect(input?.style.color).toBe(palette.text)
  expect(input?.style.minWidth).toBe(0)
  const bounds = root.renderer.getElementBounds(frame!.id)
  expect(bounds?.[2]).toBeGreaterThan(120)
  expect(bounds?.[3]).toBeGreaterThanOrEqual(28)
  expect(bounds?.[3]).toBeLessThanOrEqual(height + 4)
}

testNative('GPUix browser settings requires review and approval before sharing output to draft', async () => {
  let calls = 0
  let draft = ''
  const service = new BrowserIntegrationService({ adapters: [{ choice: { id: 'test', label: 'Test browser', available: true, description: 'Fixture account' }, run: async ({ onOutput }) => { calls++; onOutput('Fixture output') } }] })
  service.dispatch({ type: 'selectBrowserIntegration', integrationId: 'test', profile: 'work' })
  const root = createTestRoot({ width: 800, height: 1200 })
  root.render(<BrowserIntegrationSettings service={service} onUseResult={text => { draft = text }} />)
  const automation = await connectTest(root.renderer)
  try {
    root.renderer.flush()
    await automation.getByTestId('browser-task').fill('Read fixture')
    root.renderer.flush()
    await automation.getByText('Review task').click()
    root.renderer.flush()
    expect(service.getSnapshot().task?.status).toBe('review')
    expect(calls).toBe(0)
    await automation.getByText('Approve and run').click()
    await Bun.sleep(10)
    root.renderer.flush()
    expect(service.getSnapshot().task?.status).toBe('completed')
    expect(calls).toBe(1)
    expect(draft).toBe('')
    await automation.getByText('Copy result to chat draft').click()
    expect(draft).toContain('untrusted website content')
    expect(draft).toContain('Fixture output')
    await automation.getByText('Clear task and output').click()
    expect(service.getSnapshot().task).toBeNull()
  } finally { await automation.close(); root.unmount(); service.dispose() }
})

testNative('GPUix browser settings paints themed account and task inputs and saves an explicit Aside ID', async () => {
  const service = asideFixture()
  const root = createTestRoot({ width: 480, height: 420 })
  const capture = join(tmpdir(), 'heddlework-browser-profile-light.png')
  mkdirSync(tmpdir(), { recursive: true })
  applyResolvedTheme('light')
  root.render(<div testId="browser-integrations-stage" style={{ width: 480, height: 420, padding: 16, backgroundColor: colors.background }}><BrowserIntegrationSettings service={service} onUseResult={() => {}} /></div>)
  const automation = await connectTest(root.renderer)
  try {
    root.renderer.flush()
    await automation.getByText('Aside').click()
    root.renderer.flush()
    expect(service.getSnapshot().selectedId).toBe('builtin')
    expect(service.getSnapshot().profile).toBe('')
    const lightText = root.renderer.getPaintedText().join('\n')
    expect(lightText).toContain('Account ID')
    expect(lightText).toContain('not email or Profile 0')
    assertInputChrome(root, lightColors, 'browser-profile', 32)
    if (process.platform === 'darwin') {
      root.renderer.captureScreenshot(capture)
      expect(statSync(capture).size).toBeGreaterThan(1_000)
    }
    await automation.getByText('Save browser choice').click()
    root.renderer.flush()
    expect(service.getSnapshot().selectedId).toBe('builtin')
    expect(root.renderer.getPaintedText().join('\n')).toContain('Enter an explicit Aside account ID, such as u0')
    await automation.getByTestId('browser-profile').fill('Profile 0')
    root.renderer.flush()
    expect(service.getSnapshot().profile).toBe('')
    await automation.getByText('Save browser choice').click()
    root.renderer.flush()
    expect(service.getSnapshot().selectedId).toBe('builtin')
    expect(root.renderer.getPaintedText().join('\n')).toContain('Enter an explicit Aside account ID, such as u0')
    await automation.getByTestId('browser-profile').fill('u0')
    root.renderer.flush()
    expect(service.getSnapshot().profile).toBe('')
    await automation.getByText('Save browser choice').click()
    root.renderer.flush()
    expect(service.getSnapshot()).toMatchObject({ selectedId: 'aside', profile: 'u0', error: null })
    expect(root.renderer.getPaintedText().join('\n')).not.toContain('Enter an explicit Aside account ID, such as u0')
    assertInputChrome(root, lightColors, 'browser-task', 36)
    await automation.getByTestId('browser-task').fill('Read fixture mail')
    root.renderer.flush()
    expect(service.getSnapshot().task).toBeNull()
    applyResolvedTheme('dark')
    root.render(<div testId="browser-integrations-stage" style={{ width: 480, height: 420, padding: 16, backgroundColor: colors.background }}><BrowserIntegrationSettings service={service} onUseResult={() => {}} /></div>)
    root.renderer.flush()
    assertInputChrome(root, darkColors, 'browser-profile', 32)
    assertInputChrome(root, darkColors, 'browser-task', 36)
    expect(root.renderer.findByTestId('browser-profile')?.style.color).toBe(darkColors.text)
  } finally {
    await automation.close()
    root.unmount()
    service.dispose()
    applyResolvedTheme('dark')
  }
})
