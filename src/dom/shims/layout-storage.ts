import { parsePanelSizes, type LayoutStorage } from '../../ui/panel-layout.ts'
const KEY = 'heddlework.panel-layout'
export const workbenchLayoutStorage: LayoutStorage = {
  read() { try { return parsePanelSizes(JSON.parse(localStorage.getItem(KEY) ?? '{}')) } catch { return {} } },
  write(sizes) { try { localStorage.setItem(KEY, JSON.stringify(sizes)) } catch { /* Storage can be disabled by browser policy. */ } },
}
