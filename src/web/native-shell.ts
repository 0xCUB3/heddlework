// Detects the native iOS shell, which injects window.heddleworkNative before the client loads.
declare global {
  interface Window {
    heddleworkNative?: { platform: 'ios' }
    webkit?: { messageHandlers?: Record<string, { postMessage(message: unknown): void }> }
  }
}

export function isNativeShell(win: Pick<Window, 'heddleworkNative'> | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  return Boolean(win?.heddleworkNative)
}

// Sends a one-word message to the shell; a no-op in a plain browser.
export function notifyNativeShell(message: 'disconnect', win: Pick<Window, 'webkit'> | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  const handler = win?.webkit?.messageHandlers?.heddlework
  if (!handler) return false
  handler.postMessage(message)
  return true
}
