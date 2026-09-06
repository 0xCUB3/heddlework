import { useEffect, useRef, useState } from 'react'

export const STREAMING_MARKDOWN_INTERVAL_MS = 80

export function markdownCadenceCommit(
  previousCommitAt: number,
  now: number,
  streaming: boolean,
  intervalMs = STREAMING_MARKDOWN_INTERVAL_MS,
): { commit: boolean; nextDelay: number; resetClock: boolean } {
  if (!streaming) return { commit: true, nextDelay: 0, resetClock: true }
  if (previousCommitAt === 0 || now - previousCommitAt >= intervalMs) {
    return { commit: true, nextDelay: 0, resetClock: false }
  }
  return { commit: false, nextDelay: intervalMs - (now - previousCommitAt), resetClock: false }
}

export function useThrottledMarkdownSource(
  source: string,
  streaming: boolean,
  intervalMs = STREAMING_MARKDOWN_INTERVAL_MS,
): string {
  const [committed, setCommitted] = useState(source)
  const lastCommit = useRef(0)
  const latest = useRef(source)
  latest.current = source

  useEffect(() => {
    const now = performance.now()
    const decision = markdownCadenceCommit(lastCommit.current, now, streaming, intervalMs)
    if (decision.resetClock) lastCommit.current = 0
    if (decision.commit) {
      lastCommit.current = streaming ? now : 0
      setCommitted(source)
      return
    }
    const timer = setTimeout(() => {
      lastCommit.current = performance.now()
      setCommitted(latest.current)
    }, decision.nextDelay)
    return () => clearTimeout(timer)
  }, [intervalMs, source, streaming])

  return streaming ? committed : source
}
