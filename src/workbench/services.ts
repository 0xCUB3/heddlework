import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { WorkspaceDiff } from './state.ts'

export interface SessionCatalogService {
  cached?(cwd: string, limit?: number): PiSessionSummary[]
  list(cwd: string, limit?: number): Promise<PiSessionSummary[]>
  createWorkspaceSession(cwd: string): Promise<PiSessionSummary>
}

export interface WorkspaceDiffService {
  load(workspacePath: string): Promise<WorkspaceDiff>
}
