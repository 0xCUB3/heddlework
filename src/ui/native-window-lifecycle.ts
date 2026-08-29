export function isGpuixWindowCloseRace(error: unknown): boolean {
  if (!(error instanceof Error) || error.message !== 'window not found') return false

  const stack = error.stack ?? ''
  return stack.includes('@gpuix/react/dist/reconciler/batch-renderer.js')
    && stack.includes('resetAfterCommit')
}
