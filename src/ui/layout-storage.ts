import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parsePanelSizes, type LayoutStorage } from './panel-layout.ts'

export function fileLayoutStorage(path: string): LayoutStorage {
  return {
    read() { try { return parsePanelSizes(JSON.parse(readFileSync(path, 'utf8'))) } catch { return {} } },
    write(sizes) { try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(sizes), 'utf8') } catch { /* Resizing still works if preferences cannot be saved. */ } },
  }
}
export const workbenchLayoutStorage = fileLayoutStorage(join(homedir(), '.config', 'heddlework', 'panel-layout.json'))
