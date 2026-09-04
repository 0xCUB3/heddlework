import type { QueueInputDraft } from '../workbench/queue.ts'
import {
  formatFlowSessionName,
  normalizeFlowTemplate,
  type FlowLaunch,
  type FlowQueueMetadata,
  type FlowTaskSpec,
} from './types.ts'

export interface CompileTaskOptions {
  attempt?: number | undefined
  lanePath?: string | undefined
}

export function compileFlowQueue(launchInput: FlowLaunch): QueueInputDraft[] {
  const launch = normalizedLaunch(launchInput)
  return (launch.tasks ?? []).flatMap((task, taskIndex) => compileFlowTask(launch, task, taskIndex))
}

export function normalizedLaunch(launchInput: FlowLaunch): FlowLaunch {
  const template = normalizeFlowTemplate(launchInput)
  return { ...launchInput, ...template }
}

// One task becomes a fresh-session preamble and its prompt row; graph and lane facts ride along in queue metadata.
export function compileFlowTask(launch: FlowLaunch, task: FlowTaskSpec, taskIndex: number, options: CompileTaskOptions = {}): QueueInputDraft[] {
  const taskCount = launch.tasks?.length ?? launch.prompts.length
  const common = {
    runId: launch.id,
    taskId: `${launch.id}-${taskIndex + 1}`,
    title: taskCount > 1 ? `${launch.title} · Step ${taskIndex + 1}` : launch.title,
    mode: launch.mode,
    source: launch.source,
    ...(launch.scheduleId ? { scheduleId: launch.scheduleId } : {}),
    taskIndex,
    taskCount,
    specId: task.id,
    ...(task.dependsOn?.length ? { dependsOn: [...task.dependsOn] } : {}),
    ...(task.lane === 'worktree' ? { lane: 'worktree' as const } : {}),
    ...(options.lanePath ? { lanePath: options.lanePath } : {}),
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(task.retries ? { retries: task.retries } : {}),
  } satisfies Omit<FlowQueueMetadata, 'phase'>
  const row = (text: string, phase: FlowQueueMetadata['phase']): QueueInputDraft => ({
    text,
    lane: 'followUp',
    flow: { ...common, phase },
  })
  const body = launch.mode === 'parallel' ? parallelFlowPrompt(launch, task.prompt, taskIndex) : task.prompt
  return [
    row('/new', 'new-session'),
    ...(launch.model ? [row(`/model ${launch.model}`, 'set-model')] : []),
    row(`/name ${formatFlowSessionName(launch, taskIndex)}`, 'set-name'),
    row(options.lanePath ? lanePrompt(options.lanePath, body) : body, 'prompt'),
  ]
}

// Pi keeps the primary tree as its process cwd, so the lane path is a hard instruction on the prompt until per-lane transports land.
export function lanePrompt(lanePath: string, prompt: string): string {
  return [
    `[Checkout lane: ${lanePath}]`,
    `Work only inside the git worktree at ${lanePath}. Run every command with that directory as the working directory and write every file under it. Do not modify the primary working tree.`,
    '',
    'Task:',
    prompt.trim(),
  ].join('\n')
}

export function parallelFlowPrompt(launch: FlowLaunch, prompt: string, taskIndex = 0): string {
  const taskId = `${launch.id}-${taskIndex + 1}`
  return [
    `[Flow ${launch.id}]`,
    `[Flow Task ${taskId}]`,
    `Run this as a parallel Pi Fabric flow. Use fabric_exec as the only orchestration surface and set display.name exactly to "${taskId}". Decompose the work into genuinely independent workers, then launch them concurrently with workflow.parallel using thunk items such as () => workflow.agent(prompt, { name: "${taskId}/B1" }). Give every worker a unique ${taskId}/B<N> name so Heddlework can project the live branch graph from Fabric's existing audit trail. Wait for every branch to settle, join their results, and synthesize one final answer before returning. Do not create or maintain a separate task database, status, or labels.`,
    '',
    'Task:',
    prompt.trim(),
  ].join('\n')
}

export function taskPromptFromSession(firstMessage: string): string {
  const marker = '\n\nTask:\n'
  const index = firstMessage.lastIndexOf(marker)
  return index >= 0 ? firstMessage.slice(index + marker.length).trim() : firstMessage.trim()
}
