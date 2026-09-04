import { describe, expect, it } from 'bun:test'
import { readyTasks, topologicalOrder } from '../src/flows/graph.ts'
import { normalizeFlowTemplate, validateFlowGraph, type FlowTaskSpec } from '../src/flows/types.ts'

const tasks: FlowTaskSpec[] = [
  { id: 'a', prompt: 'A' },
  { id: 'b', prompt: 'B', dependsOn: ['a'] },
  { id: 'c', prompt: 'C', dependsOn: ['a'] },
  { id: 'd', prompt: 'D', dependsOn: ['b', 'c'] },
]

describe('flow graph', () => {
  it('rejects cycles, self references, and unknown ids by name', () => {
    expect(() => validateFlowGraph([{ id: 'a', prompt: 'A', dependsOn: ['b'] }, { id: 'b', prompt: 'B', dependsOn: ['a'] }])).toThrow('cycle: a -> b -> a')
    expect(() => validateFlowGraph([{ id: 'a', prompt: 'A', dependsOn: ['a'] }])).toThrow('Task a depends on itself')
    expect(() => validateFlowGraph([{ id: 'a', prompt: 'A', dependsOn: ['zzz'] }])).toThrow('Task a depends on unknown task zzz')
    expect(() => validateFlowGraph([{ id: 'a', prompt: 'A' }, { id: 'a', prompt: 'B' }])).toThrow('Duplicate flow task id: a')
  })

  it('orders tasks topologically while preserving declared order among peers', () => {
    const shuffled = [tasks[3]!, tasks[2]!, tasks[0]!, tasks[1]!]
    expect(topologicalOrder(shuffled).map((task) => task.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('evolves the ready set as tasks complete and blocks on failure', () => {
    const completed = new Set<string>()
    const failed = new Set<string>()
    expect(readyTasks(tasks, completed, failed).ready.map((task) => task.id)).toEqual(['a'])
    completed.add('a')
    let readiness = readyTasks(tasks, completed, failed)
    expect(readiness.ready.map((task) => task.id)).toEqual(['b', 'c'])
    expect(readiness.waiting.map((task) => task.id)).toEqual(['d'])
    failed.add('b')
    readiness = readyTasks(tasks, completed, failed)
    expect(readiness.ready.map((task) => task.id)).toEqual(['c'])
    expect(readiness.blocked.map((task) => task.id)).toEqual(['d'])
  })

  it('derives sequential and parallel graphs from legacy prompts and keeps explicit tasks', () => {
    const sequential = normalizeFlowTemplate({ title: '', prompts: ['one', 'two', 'three'], mode: 'sequential', workspacePath: '/w' })
    expect(sequential.tasks).toEqual([{ id: 't1', prompt: 'one' }, { id: 't2', prompt: 'two', dependsOn: ['t1'] }, { id: 't3', prompt: 'three', dependsOn: ['t2'] }])
    const parallel = normalizeFlowTemplate({ title: '', prompts: ['one', 'two'], mode: 'parallel', workspacePath: '/w' })
    expect(parallel.tasks).toEqual([{ id: 't1', prompt: 'one\n\ntwo' }])
    const explicit = normalizeFlowTemplate({ title: 'x', prompts: [], mode: 'sequential', workspacePath: '/w', tasks: [{ id: 'lint', prompt: 'lint' }, { id: 'fix', prompt: 'fix', dependsOn: ['lint'], lane: 'worktree', retries: 2 }] })
    expect(explicit.tasks).toEqual([{ id: 'lint', prompt: 'lint' }, { id: 'fix', prompt: 'fix', dependsOn: ['lint'], lane: 'worktree', retries: 2 }])
    expect(explicit.prompts).toEqual(['lint', 'fix'])
  })
})
