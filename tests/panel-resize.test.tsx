import React from 'react'
import { describe, expect, it } from 'bun:test'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { connectTest } from '@gpuix/react/automation'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { MemoryTerminalBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { SPRING_SETTLE_MS } from '../src/ui/motion.ts'
import type { PanelSizes } from '../src/ui/panel-layout.ts'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'
const native=hasNativeTestRenderer?describe:describe.skip
native('workbench dividers',()=>{
 it('keeps compact navigation and panels as overlays without resize handles',async()=>{
  const controller=new WorkbenchController(new DemoTransport(),'/tmp/resize-mobile',testControllerDependencies())
  const root=createTestRoot({width:390,height:800})
  const app=await connectTest(root.renderer)
  try {
   root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={createTestUiRegistry(controller)} layoutStorage={{read:()=>({sidebar:440,right:800}),write:()=>{}}} />)
   await Bun.sleep(50);root.renderer.flush()
   expect(await app.getByTestId('left-sidebar-resize').count()).toBe(0)
   await app.getByTestId('toggle-diff').click()
   root.renderer.flush();await Bun.sleep(SPRING_SETTLE_MS+40);root.renderer.flush()
   expect(await app.getByTestId('right-panel-resize').count()).toBe(0)
   expect((await app.getByTestId('right-panel-host').bounds()).width).toBeCloseTo(390,0)
  }finally{await app.close();root.unmount();await controller.dispose()}
 })
 it('drags both sidebars, cancels with Escape and restores persisted width',async()=>{
  let saved:PanelSizes={sidebar:280}
  const storage={read:()=>saved,write:(value:PanelSizes)=>{saved={...value}}}
  const controller=new WorkbenchController(new DemoTransport(),'/tmp/resize',testControllerDependencies())
  const root=createTestRoot({width:1440,height:800})
  const app=await connectTest(root.renderer)
  const render=()=>root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={createTestUiRegistry(controller)} layoutStorage={storage} />)
  const settle=async()=>{root.renderer.flush();await Bun.sleep(SPRING_SETTLE_MS+40);root.renderer.flush()}
  try {
   render();await settle()
   const left=app.getByTestId('left-sidebar-resize')
   await left.dragBy(80,0);await settle()
   expect(saved.sidebar).toBe(360)
   expect((await app.getByTestId('left-sidebar-host').bounds()).width).toBeCloseTo(360,0)
   await app.getByTestId('toggle-diff').click();await settle()
   const right=app.getByTestId('right-panel-resize')
   const before=(await app.getByTestId('right-panel-host').bounds()).width
   await right.dragBy(-60,0);await settle()
   expect(saved.right).toBeCloseTo(before+60,0)
   const point=await left.center()
   await app.mouse.down(point);await app.mouse.move({x:point.x+30,y:point.y})
   await app.getByTestId('panel-resize-overlay').press('escape');await settle()
   expect((await app.getByTestId('left-sidebar-host').bounds()).width).toBeCloseTo(360,0)
   await app.mouse.up(point)
   expect(saved.sidebar).toBe(360)
   root.render(null);await settle();render();await settle()
   expect((await app.getByTestId('left-sidebar-host').bounds()).width).toBeCloseTo(360,0)
  } finally {await app.close();root.unmount();await controller.dispose()}
 })
 it('resizes the terminal divider and persists its height',async()=>{
  const controller=new WorkbenchController(new DemoTransport(),'/tmp/resize-terminal',testControllerDependencies())
  const terminals=new TerminalSessionService({cwd:'/tmp/resize-terminal',backend:new MemoryTerminalBackend('prompt> ')})
  let saved:PanelSizes={}
  const root=createTestRoot({width:1280,height:800})
  const app=await connectTest(root.renderer)
  try {
   root.render(<WorkbenchApp controller={controller} terminals={terminals} presenters={new Map()} ui={createTestUiRegistry(controller)} layoutStorage={{read:()=>saved,write:value=>{saved=value}}} />)
   await Bun.sleep(50);root.renderer.flush()
   await app.getByTestId('toggle-terminal').click()
   await Bun.sleep(SPRING_SETTLE_MS+80);root.renderer.flush()
   const before=(await app.getByTestId('terminal-dock').bounds()).height
   await app.getByTestId('terminal-dock-resize').dragBy(0,-80)
   await Bun.sleep(50);root.renderer.flush()
   expect(saved.terminal).toBe(320)
   expect((await app.getByTestId('terminal-dock').bounds()).height).toBeCloseTo(before+80,0)
  } finally {await app.close();root.unmount();await controller.dispose();await terminals.dispose()}
 })
})
