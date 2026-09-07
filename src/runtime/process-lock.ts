import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, ftruncateSync, openSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { privateDirectory } from './paths.ts'

const locks = process.platform === 'win32' ? undefined : dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})

const windowsLocks = process.platform !== 'win32' ? undefined : dlopen('kernel32.dll', {
  CreateMutexW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  ReleaseMutex: { args: [FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
})
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

// Keep the inode in place. Unlinking a locked file permits another process to lock a
// different inode at the same path, defeating exclusion during restart races.
export function tryProcessLock(path: string): (() => void) | undefined {
  privateDirectory(dirname(path))
  if (locks) {
    const fd = openSync(path, 'a+', 0o600)
    if (locks.symbols.flock(fd, 2 | 4) !== 0) { closeSync(fd); return undefined }
    try { ftruncateSync(fd, 0); writeFileSync(fd, JSON.stringify({ pid: process.pid })) } catch (error) { closeSync(fd); throw error }
    let released = false
    return () => { if (!released) { released = true; closeSync(fd) } }
  }
  if (!windowsLocks) throw new Error('Runtime locking is unavailable on this platform')
  const key = createHash('sha256').update(resolve(path).toLowerCase()).digest('hex')
  const name = Buffer.from(`Local\\Heddlework.${key}\0`, 'utf16le')
  const handle = windowsLocks.symbols.CreateMutexW(null, 0, name)
  if (!handle) throw new Error('Could not create the Heddlework runtime mutex')
  const result = windowsLocks.symbols.WaitForSingleObject(handle, 0)
  if (result !== 0 && result !== 0x80) { windowsLocks.symbols.CloseHandle(handle); return undefined }
  let released = false
  return () => {
    if (released) return
    released = true
    windowsLocks.symbols.ReleaseMutex(handle)
    windowsLocks.symbols.CloseHandle(handle)
  }
}

export async function acquireProcessLock(path: string, timeoutMs = 90_000): Promise<() => void> {
  const deadline = Date.now() + timeoutMs
  do {
    const release = tryProcessLock(path)
    if (release) return release
    await Bun.sleep(50)
  } while (Date.now() < deadline)
  throw new Error(`Another Heddlework process still owns ${path}`)
}
