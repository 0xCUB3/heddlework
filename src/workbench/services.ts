import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { WorkspaceDiff } from './state.ts'

export interface SessionCatalogService {
  list(cwd: string, limit?: number): Promise<PiSessionSummary[]>
}

export interface WorkspaceDiffService {
  load(workspacePath: string): Promise<WorkspaceDiff>
}
