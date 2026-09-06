import { asRecord } from './state.ts'

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function tokens(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value)) }
function seconds(value: number): string { return `${(value / 1000).toFixed(1)}s` }

// Optional structured turn telemetry (including pi-tps). No model or provider assumptions.
export function formatTurnTelemetry(value: unknown): string | undefined {
  const data = asRecord(value)
  const timing = asRecord(data.timing)
  const usage = asRecord(data.tokens)
  const duration = number(timing.totalMs)
  const output = number(usage.output)
  if (duration === undefined || output === undefined || !('tps' in data)) return undefined
  const rate = number(data.tps)
  const parts = [`TPS ${rate === undefined ? '—' : rate.toFixed(1)}`]
  const ttft = number(timing.ttftMs)
  if (ttft !== undefined) parts.push(`TTFT ${seconds(ttft)}`)
  parts.push(seconds(duration))
  const input = number(usage.input)
  if (input !== undefined) parts.push(`in ${tokens(input)}`)
  parts.push(`out ${tokens(output)}`)
  const cache = (number(usage.cacheRead) ?? 0) + (number(usage.cacheWrite) ?? 0)
  if (cache > 0) parts.push(`cache ${tokens(cache)}`)
  const stall = number(timing.stallMs)
  const count = number(timing.stallCount)
  if (stall && count) parts.push(`stall ${seconds(stall)} ×${count}`)
  const cost = number(data.billedCost) ?? number(asRecord(data.cost).total)
  if (cost !== undefined) parts.push(`$${cost.toFixed(4)}`)
  return parts.join(' · ')
}

export function formatMessageUsage(value: unknown): string | undefined {
  const usage = asRecord(value)
  const input = number(usage.input)
  const output = number(usage.output)
  if (input === undefined && output === undefined) return undefined
  const parts: string[] = []
  if (input !== undefined) parts.push(`in ${tokens(input)}`)
  if (output !== undefined) parts.push(`out ${tokens(output)}`)
  const cache = (number(usage.cacheRead) ?? 0) + (number(usage.cacheWrite) ?? 0)
  if (cache) parts.push(`cache ${tokens(cache)}`)
  const cost = number(asRecord(usage.cost).total)
  if (cost !== undefined) parts.push(`$${cost.toFixed(4)}`)
  return parts.join(' · ')
}
