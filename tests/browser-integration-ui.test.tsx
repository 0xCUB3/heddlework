import React from 'react'
import { expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { BrowserIntegrationService } from '../src/browser/integrations.ts'
import { BrowserIntegrationSettings } from '../src/ui/browser-integration-settings.tsx'

const testNative = hasNativeTestRenderer ? it : it.skip
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
