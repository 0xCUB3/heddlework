import { describe, expect, it } from 'bun:test'
import { isGpuixWindowCloseRace } from '../src/ui/native-window-lifecycle.ts'

describe('native window lifecycle', () => {
  it('recognizes a late GPUix batch commit after the native window closes', () => {
    const error = new Error('window not found')
    error.stack = `Error: window not found
    at <anonymous> (/project/node_modules/@gpuix/react/dist/reconciler/batch-renderer.js:94:52)
    at resetAfterCommit (/project/node_modules/@gpuix/react/dist/reconciler/host-config.js:225:32)
    at commitRoot (/project/node_modules/react-reconciler/react-reconciler.development.js:12848:11)`

    expect(isGpuixWindowCloseRace(error)).toBe(true)
  })

  it('does not classify unrelated application or renderer failures as shutdown', () => {
    expect(isGpuixWindowCloseRace(new Error('window not found'))).toBe(false)

    const rendererFailure = new Error('invalid element')
    rendererFailure.stack = 'at resetAfterCommit (/project/node_modules/@gpuix/react/dist/reconciler/host-config.js:225:32)'
    expect(isGpuixWindowCloseRace(rendererFailure)).toBe(false)
    expect(isGpuixWindowCloseRace('window not found')).toBe(false)
  })
})
