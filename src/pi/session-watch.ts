import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'

/** One native watcher per catalog root, not one timer or watcher per session. */
export function watchPiSessions(
  directory: string,
  changed: () => void,
  options: { recursive?: boolean; debounceMs?: number; retryMs?: number } = {},
): () => void {
  let closed = false
  let watcher: FSWatcher | undefined
  let identity: string | undefined
  let probing = false
  let notification: ReturnType<typeof setTimeout> | undefined
  const notify = () => {
    // Bound latency even when several terminals keep writing continuously.
    if (closed || notification) return
    notification = setTimeout(() => {
      notification = undefined
      if (!closed) changed()
    }, options.debounceMs ?? 150)
    notification.unref?.()
  }
  const probe = async (fallbackRefresh = false) => {
    if (closed || probing) return
    probing = true
    try {
      const info = await stat(directory)
      if (closed) return
      const nextIdentity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
      if (nextIdentity !== identity) {
        watcher?.close()
        watcher = undefined
        identity = nextIdentity
        // Also catches a root created after subscription, and root replacement.
        notify()
      }
      if (!watcher) {
        try {
          const opened = watch(directory, { recursive: options.recursive ?? true, persistent: false }, (event, filename) => {
            if (!filename || String(filename).endsWith('.jsonl') || event === 'rename') notify()
          })
          watcher = opened
          opened.on('error', () => {
            opened.close()
            if (watcher === opened) watcher = undefined
            notify()
          })
        } catch {
          // Network filesystems or older runtimes may not support native watches.
          if (fallbackRefresh) notify()
        }
      }
    } catch {
      if (identity !== undefined) notify()
      identity = undefined
      watcher?.close()
      watcher = undefined
    } finally {
      probing = false
    }
  }
  void probe()
  // A single directory stat recovers deletion/recreation and unavailable watches;
  // a healthy watcher never polls or re-reads all the session files.
  const retry = setInterval(() => { void probe(true) }, options.retryMs ?? 5_000)
  retry.unref?.()
  return () => {
    closed = true
    watcher?.close()
    if (notification) clearTimeout(notification)
    clearInterval(retry)
  }
}
