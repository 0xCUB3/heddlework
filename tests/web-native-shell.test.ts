import { describe, expect, test } from 'bun:test'
import { isNativeShell, notifyNativeShell } from '../src/web/native-shell.ts'

describe('native shell detection', () => {
  test('reports the shell only when the bootstrap global is present', () => {
    expect(isNativeShell(undefined)).toBe(false)
    expect(isNativeShell({ heddleworkNative: undefined })).toBe(false)
    expect(isNativeShell({ heddleworkNative: { platform: 'ios' } })).toBe(true)
  })

  test('posts to the heddlework message handler when the shell provides one', () => {
    const posted: unknown[] = []
    const win = { webkit: { messageHandlers: { heddlework: { postMessage: (message: unknown) => { posted.push(message) } } } } }
    expect(notifyNativeShell('disconnect', win)).toBe(true)
    expect(posted).toEqual(['disconnect'])
    expect(notifyNativeShell('disconnect', {})).toBe(false)
    expect(notifyNativeShell('disconnect', undefined)).toBe(false)
  })
})
