export function workspaceDisplayName(path: string | undefined | null): string {
  const parts = String(path ?? '').split(/[/\\]/).filter((part) => part && part !== '.' && part !== '..')
  return parts.at(-1) || 'workspace'
}
