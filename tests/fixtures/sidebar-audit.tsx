import React, { useState } from 'react'
import { SessionRow } from '../../src/ui/sidebar-session-row.tsx'
import { colors } from '../../src/ui/theme.ts'

export function SidebarAudit({ width = 280 }: { width?: number }) {
  const [selected, select] = useState('git')
  const [snooze, setSnooze] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const record = (value: string) => setEvents(previous => [...previous, value])
  const rows = [
    { id: 'git', project: 'heddlework', title: 'Make the sidebar feel right', branch: 'main' },
    { id: 'plain', project: 'Notes', title: 'Ideas for the weekend' },
    { id: 'long', project: 'wBlock', title: 'Investigate the toolbar regression on macOS', branch: 'fix/sidebar-pointer-targets-and-spacing' },
    { id: 'short', project: 'Notes', title: 'Thanks' },
    { id: 'settled', project: 'Notes', title: 'Saved idea' },
  ]
  return <div style={{ width, height: 500, display: 'flex', flexDirection: 'column', backgroundColor: colors.sidebar }}>
    <div style={{ height: 42, paddingLeft: 18, justifyContent: 'center' }}><text style={{ color: colors.textMuted, fontSize: 12, fontWeight: 600 }}>All projects</text></div>
    {rows.map(row => <div key={row.id} testId={`audit-${row.id}`}>
      <SessionRow sidebarWidth={width} session={{ id: row.id, path: `/tmp/${row.id}.jsonl`, cwd: `/tmp/${row.project}`, title: row.title, firstMessage: row.title, messageCount: 2, createdAt: 0, modifiedAt: Date.now() - 3_600_000, branch: row.branch }}
        projectName={row.project} active={selected === row.id} running={false} disabled={false} lifecycle={row.id === 'settled' ? 'settled' : 'active'} snoozeOpen={snooze === row.id}
        onClick={() => { select(row.id); record(`open:${row.id}`) }}
        onSettle={() => record(`settle:${row.id}`)} onWake={() => record(`wake:${row.id}`)}
        onSnooze={() => { setSnooze(snooze === row.id ? '' : row.id); record(`snooze:${row.id}`) }}
        onSchedule={() => { setSnooze(''); record(`schedule:${row.id}`) }} />
    </div>)}
    <text testId="audit-events" style={{ fontSize: 9, color: colors.textFaint, padding: 12 }}>{events.join(',')}</text>
  </div>
}
