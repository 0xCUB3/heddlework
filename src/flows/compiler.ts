import type { QueueInputDraft } from '../workbench/queue.ts'
import {
  formatFlowSessionName,
  normalizeFlowTemplate,
  type FlowLaunch,
  type FlowQueueMetadata,
} from './types.ts'

export function compileFlowQueue(launchInput: FlowLaunch): QueueInputDraft[] {
  const template = normalizeFlowTemplate(launchInput)
  const launch: FlowLaunch = { ...launchInput, ...template }
  return launch.prompts.flatMap((prompt, taskIndex) => {
    const common = {
      runId: launch.id,
      taskId: `${launch.id}-${taskIndex + 1}`,
      title: launch.prompts.length > 1 ? `${launch.title} · Step ${taskIndex + 1}` : launch.title,
      mode: launch.mode,
      source: launch.source,
      ...(launch.scheduleId ? { scheduleId: launch.scheduleId } : {}),
      taskIndex,
      taskCount: launch.prompts.length,
    } satisfies Omit<FlowQueueMetadata, 'phase'>
    const row = (text: string, phase: FlowQueueMetadata['phase']): QueueInputDraft => ({
      text,
      lane: 'followUp',
      flow: { ...common, phase },
    })
    return [
      row('/new', 'new-session'),
      ...(launch.model ? [row(`/model ${launch.model}`, 'set-model')] : []),
      row(`/name ${formatFlowSessionName(launch, taskIndex)}`, 'set-name'),
      row(launch.mode === 'parallel' ? parallelFlowPrompt(launch, prompt, taskIndex) : prompt, 'prompt'),
    ]
  })
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
  const index = firstMessage.indexOf(marker)
  return index >= 0 ? firstMessage.slice(index + marker.length).trim() : firstMessage.trim()
}
