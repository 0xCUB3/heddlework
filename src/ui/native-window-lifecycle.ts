export function isGpuixWindowCloseRace(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(isGpuixWindowCloseRace)
  }
  if (!(error instanceof Error) || error.message !== 'window not found') return false

  const stack = error.stack ?? ''
  return stack.includes('@gpuix/react/dist/reconciler/batch-renderer.js')
    && stack.includes('resetAfterCommit')
}
