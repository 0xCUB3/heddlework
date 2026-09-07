import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampPanelSize, draggedPanelSize, parsePanelSizes } from '../src/ui/panel-layout.ts'
import { fileLayoutStorage } from '../src/ui/layout-storage.ts'
import { workbenchLayoutStorage as browserStorage } from '../src/dom/shims/layout-storage.ts'
it('clamps each divider direction and preserves room for the center', () => {
  expect(draggedPanelSize('sidebar', 280, 80, 440)).toBe(360)
  expect(draggedPanelSize('right', 420, -100, 600)).toBe(520)
  expect(draggedPanelSize('terminal', 240, -80, 640)).toBe(320)
  expect(draggedPanelSize('sidebar', 280, -1000, 440)).toBe(220)
  expect(draggedPanelSize('right', 420, -1000, 480)).toBe(480)
  expect(clampPanelSize(240, 140, 100)).toBe(100)
  expect(parsePanelSizes({sidebar: NaN, right: -1, terminal: 260.4})).toEqual({terminal:260})
})
it('persists dimensions and tolerates corrupt preferences', () => {
  const dir=mkdtempSync(join(tmpdir(),'hw-panel-layout-'))
  try {
    const path=join(dir,'layout.json'), store=fileLayoutStorage(path)
    expect(store.read()).toEqual({})
    store.write({sidebar:320,right:480,terminal:300})
    expect(fileLayoutStorage(path).read()).toEqual({sidebar:320,right:480,terminal:300})
    writeFileSync(path,'broken'); expect(store.read()).toEqual({})
  } finally {rmSync(dir,{recursive:true,force:true})}
})

it('round-trips browser dimensions and tolerates blocked localStorage', () => {
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage')
  const values=new Map<string,string>()
  try {
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)}})
    browserStorage.write({sidebar:304,right:512,terminal:288})
    expect(browserStorage.read()).toEqual({sidebar:304,right:512,terminal:288})
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{throw new Error('blocked')}})
    expect(browserStorage.read()).toEqual({})
    expect(()=>browserStorage.write({sidebar:300})).not.toThrow()
  }finally{
    if(original)Object.defineProperty(globalThis,'localStorage',original)
    else Reflect.deleteProperty(globalThis,'localStorage')
  }
})
