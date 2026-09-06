// Native macOS windows draw their traffic lights over the top-left of the content, so headers there leave room for
// them. Browsers never do, whatever the visitor's OS, so the inset collapses to zero when a document exists.

export function hasNativeTrafficLights(): boolean {
  return process.platform === 'darwin' && typeof document === 'undefined'
}

/** Horizontal inset for a header that sits under the traffic lights at the given titlebar progress (0..1). */
export function trafficLightInset(progress: number, width = 96): number {
  return hasNativeTrafficLights() ? width * progress : 0
}
