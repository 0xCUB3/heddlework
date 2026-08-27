export function formatElapsedSeconds(value: number): string {
  const seconds = Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1
  if (seconds < 60) return `${seconds}s`

  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
  }

  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3_600)
    const minutes = Math.floor((seconds % 3_600) / 60)
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  }

  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}
