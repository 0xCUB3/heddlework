import React, { useEffect, useMemo, useState } from 'react'
import type { FlowRuntime } from '../flows/runtime.ts'
import type { FlowMode, FlowScheduleTiming } from '../flows/types.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Button, ChipSelect, type SelectOption } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'

export function FlowIntake({ state, runtime, purpose, onCreated, onCancel }: {
  state: WorkbenchState
  runtime: FlowRuntime
  purpose: 'run' | 'schedule'
  onCreated(id: string): void
  onCancel(): void
}) {
  const currentModel = state.session.model ? `${state.session.model.provider}/${state.session.model.id}` : ''
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<FlowMode>('sequential')
  const [prompts, setPrompts] = useState([''])
  const [model, setModel] = useState(currentModel)
  const [timingKind, setTimingKind] = useState<'once' | 'interval' | 'daily'>('once')
  const [timingValue, setTimingValue] = useState(defaultOnceValue())
  const [error, setError] = useState<string | undefined>()
  useEffect(() => { if (!model && currentModel) setModel(currentModel) }, [currentModel, model])
  const modelOptions = useMemo<SelectOption[]>(() => state.models.map((candidate) => ({
    value: `${candidate.provider}/${candidate.id}`,
    label: candidate.name ?? candidate.id,
    detail: `${candidate.provider}/${candidate.id}`,
  })), [state.models])
  const valid = prompts.some((prompt) => prompt.trim())
  const submit = () => {
    try {
      const template = { title, prompts, mode, ...(model ? { model } : {}), workspacePath: state.workspacePath }
      if (purpose === 'run') {
        const launch = runtime.launch(template)
        onCreated(launch.id)
      } else {
        const schedule = runtime.createSchedule({ ...template, timing: parseTiming(timingKind, timingValue) })
        onCreated(schedule.id)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }
  const chooseMode = (value: string) => {
    const next = value as FlowMode
    setMode(next)
    if (next === 'parallel' && prompts.length > 1) setPrompts([prompts.filter(Boolean).join('\n\n')])
  }
  return (
    <div testId={purpose === 'run' ? 'flow-intake' : 'schedule-intake'} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 13, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flexGrow: 1 }}>
          <text style={{ color: colors.text, fontSize: 15, fontWeight: 650 }}>{purpose === 'run' ? 'New flow' : 'Schedule a flow'}</text>
          <text style={{ color: colors.textFaint, fontSize: 10 }}>{purpose === 'run' ? 'Compile work into Pi queue primitives.' : 'The runtime will enqueue a fresh Pi session when this job is due.'}</text>
        </div>
        <Button label="Cancel" tone="quiet" compact onClick={onCancel} />
      </div>
      <Field label="Title">
        <FramedInput testId="flow-title" value={title} placeholder="Derived from the first prompt if blank" onChange={setTitle} />
      </Field>
      <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <ChipSelect backdropColor={colors.card} testId="flow-mode" label="Mode" value={mode} options={[
          { value: 'sequential', label: 'Sequential', detail: '/new → /model → prompt for every step' },
          { value: 'parallel', label: 'Parallel', detail: 'One prompt orchestrated through pi-fabric' },
        ]} width={290} triggerMaxWidth={190} onChange={chooseMode} />
        <ChipSelect backdropColor={colors.card} testId="flow-model" icon="sparkles" value={model} options={modelOptions} width={320} triggerMaxWidth={260} searchable onChange={setModel} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {prompts.map((prompt, index) => (
          <Field key={index} label={mode === 'parallel' ? 'Parallel task' : `Step ${index + 1}`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                testId={`flow-prompt-${index}`}
                value={prompt}
                placeholder={mode === 'parallel' ? 'Describe the work that Fabric should decompose and run concurrently…' : 'Describe this fresh-session task…'}
                minRows={3}
                maxRows={8}
                theme={nativeTheme}
                style={{ width: '100%', minWidth: 0, padding: 10, color: colors.text, fontSize: 12, lineHeight: 18, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 9, backgroundColor: colors.input }}
                onChange={(event) => setPrompts((current) => current.map((value, promptIndex) => promptIndex === index ? String(event.value ?? '') : value))}
              />
              {mode === 'sequential' && prompts.length > 1 && <div style={{ alignSelf: 'flex-end' }}><Button label="Remove step" tone="quiet" compact onClick={() => setPrompts((current) => current.filter((_, promptIndex) => promptIndex !== index))} /></div>}
            </div>
          </Field>
        ))}
        {mode === 'sequential' && <div style={{ alignSelf: 'flex-start' }}><Button testId="flow-add-step" label="Add step" icon="plus" compact onClick={() => setPrompts((current) => [...current, ''])} /></div>}
      </div>
      {purpose === 'schedule' && (
        <div testId="schedule-controls" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10 }}>
          <Field label="Cadence">
            <ChipSelect backdropColor={colors.card} testId="schedule-kind" value={timingKind} options={[
              { value: 'once', label: 'Once' },
              { value: 'interval', label: 'Interval' },
              { value: 'daily', label: 'Daily' },
            ]} width={180} triggerMaxWidth={150} onChange={(value) => {
              const kind = value as typeof timingKind
              setTimingKind(kind)
              setTimingValue(kind === 'once' ? defaultOnceValue() : kind === 'interval' ? '60' : defaultDailyValue())
            }} />
          </Field>
          <Field label={timingKind === 'once' ? 'Local date and time' : timingKind === 'interval' ? 'Minutes' : 'Local time'}>
            <FramedInput testId="schedule-value" value={timingValue} width={220} placeholder={timingKind === 'once' ? '2026-08-29 09:30' : timingKind === 'interval' ? '60' : '09:30'} onChange={setTimingValue} />
          </Field>
        </div>
      )}
      {error && <text testId="flow-intake-error" style={{ color: colors.error, fontSize: 10 }}>{error}</text>}
      <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end' }}>
        <Button testId={purpose === 'run' ? 'flow-create' : 'schedule-create'} label={purpose === 'run' ? 'Queue flow' : 'Create schedule'} tone="primary" icon={purpose === 'run' ? 'arrowUp' : 'clock'} disabled={!valid} onClick={submit} />
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}><text style={{ height: 12, color: colors.textFaint, fontSize: 9, lineHeight: 12, fontWeight: 650 }}>{label.toUpperCase()}</text>{children}</div>
}

function FramedInput({ testId, value, placeholder, width = '100%', onChange }: { testId: string; value: string; placeholder: string; width?: number | string; onChange(value: string): void }) {
  return (
    <div testId={`${testId}-frame`} style={{ width, minWidth: 0, height: 36, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingRight: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}>
      <input testId={testId} value={value} placeholder={placeholder} theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }} style={{ width: 0, minWidth: 0, height: 32, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 12 }} onChange={(event) => onChange(String(event.value ?? ''))} />
    </div>
  )
}

function parseTiming(kind: 'once' | 'interval' | 'daily', value: string): FlowScheduleTiming {
  if (kind === 'once') {
    const at = Date.parse(value.trim().replace(' ', 'T'))
    if (!Number.isFinite(at)) throw new Error('Enter a valid local date and time')
    return { kind, at }
  }
  if (kind === 'interval') {
    const everyMinutes = Number(value)
    if (!Number.isFinite(everyMinutes) || everyMinutes < 1) throw new Error('Interval must be at least one minute')
    return { kind, everyMinutes, anchorAt: Date.now() + everyMinutes * 60_000 }
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  const hour = Number(match?.[1])
  const minute = Number(match?.[2])
  if (!match || hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('Daily time must use HH:MM')
  return { kind, hour, minute }
}

function defaultOnceValue(): string {
  const date = new Date(Date.now() + 60 * 60_000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function defaultDailyValue(): string {
  const date = new Date(Date.now() + 60 * 60_000)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
