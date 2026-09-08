import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

export type PiSessionWatchListener = (paths: string[]) => void

export type PiSessionWatchOpen = typeof watch

/** One native watcher per catalog root, not one timer or watcher per session. */
export function watchPiSessions(
  directory: string,
  changed: PiSessionWatchListener | (() => void),
  options: { recursive?: boolean; debounceMs?: number; retryMs?: number; openWatch?: PiSessionWatchOpen } = {},
): () => void {
  const root = resolve(directory)
  const openWatch = options.openWatch ?? watch
  let closed = false
  let watcher: FSWatcher | undefined
  let parentWatcher: FSWatcher | undefined
  let identity: string | undefined
  let fallbackStamp: string | undefined
  let probing = false
  let notification: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<string>()
  let unknown = false
  const notify = () => {
    // Bound latency even when several terminals keep writing continuously.
    if (closed || notification) return
    notification = setTimeout(() => {
      notification = undefined
      if (closed) return
      if (unknown) {
        unknown = false
        pending.clear()
        changed([])
        return
      }
      const paths = [...pending]
      pending.clear()
      changed(paths)
    }, options.debounceMs ?? 150)
    notification.unref?.()
  }
  const closeParent = () => {
    parentWatcher?.close()
    parentWatcher = undefined
  }
  const watchParent = () => {
    if (closed || parentWatcher) return
    const parent = dirname(root)
    if (parent === root) return
    try {
      const opened = openWatch(parent, { persistent: false }, (_event, filename) => {
        if (closed) return
        if (filename && String(filename) !== basename(root)) return
        void probe()
      })
      parentWatcher = opened
      opened.on('error', () => {
        opened.close()
        if (parentWatcher === opened) parentWatcher = undefined
      })
    } catch {
      // Parent may also be missing; the cheap retry stat recovers it.
    }
  }
  const probe = async (fallbackRefresh = false) => {
    if (closed || probing) return
    probing = true
    try {
      const info = await stat(root)
      if (closed) return
      closeParent()
      const nextIdentity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
      if (nextIdentity !== identity) {
        watcher?.close()
        watcher = undefined
        identity = nextIdentity
        fallbackStamp = undefined
        // Also catches a root created after subscription, and root replacement.
        unknown = true
        notify()
      }
      if (!watcher) {
        try {
          const opened = openWatch(root, { recursive: options.recursive ?? true, persistent: false }, (event, filename) => {
            if (!filename) {
              unknown = true
              notify()
              return
            }
            const name = String(filename)
            if (!name.endsWith('.jsonl') && event !== 'rename') return
            pending.add(resolve(root, name))
            notify()
          })
          watcher = opened
          fallbackStamp = undefined
          opened.on('error', () => {
            opened.close()
            if (watcher === opened) watcher = undefined
            unknown = true
            notify()
          })
        } catch {
          // Network filesystems or older runtimes may not support native watches.
          // One directory stat is the fallback; do not rescan on every retry.
          if (fallbackRefresh) {
            const stamp = `${nextIdentity}:${info.mtimeMs}`
            if (stamp !== fallbackStamp) {
              fallbackStamp = stamp
              unknown = true
              notify()
            }
          }
        }
      }
    } catch {
      if (identity !== undefined) {
        unknown = true
        notify()
      }
      identity = undefined
      fallbackStamp = undefined
      watcher?.close()
      watcher = undefined
      watchParent()
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
    closeParent()
    if (notification) clearTimeout(notification)
    clearInterval(retry)
  }
}
