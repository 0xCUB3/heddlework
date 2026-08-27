import React from 'react'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  type ComboboxItemState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  type SelectItemState,
  type SelectTriggerState,
} from '@gpuix/react'
import { Icon, type IconName } from './icons.tsx'
import { colors } from './theme.ts'

export interface ButtonProps {
  label: string
  onClick?: () => void
  disabled?: boolean
  tone?: 'default' | 'primary' | 'danger' | 'quiet'
  testId?: string
  compact?: boolean
  icon?: IconName
}

export function Button({ label, onClick, disabled = false, tone = 'default', testId, compact = false, icon }: ButtonProps) {
  const palette = tone === 'primary'
    ? { background: colors.primary, foreground: '#FFFFFF', border: colors.primary }
    : tone === 'danger'
      ? { background: '#3A1B22', foreground: colors.error, border: '#52262E' }
      : tone === 'quiet'
        ? { background: colors.transparent, foreground: colors.textMuted, border: colors.transparent }
        : { background: colors.raised, foreground: colors.text, border: colors.borderStrong }
  const handlers = disabled || !onClick ? {} : {
    onClick,
    onKeyDown: (event: { key?: string }) => {
      if (event.key === 'enter' || event.key === 'space') onClick()
    },
  }
  return (
    <div
      {...(testId ? { testId } : {})}
      tabIndex={disabled ? -1 : 0}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: compact ? 28 : 32,
        paddingLeft: compact ? 9 : 12,
        paddingRight: compact ? 9 : 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
        opacity: disabled ? 0.35 : 1,
        userSelect: 'none',
        ...(disabled ? {} : { cursor: 'pointer', hover: { backgroundColor: tone === 'primary' ? colors.primaryHover : colors.hover } }),
      }}
      {...handlers}
    >
      {icon && <Icon name={icon} size={compact ? 13 : 14} color={palette.foreground} />}
      <text style={{ color: palette.foreground, fontSize: compact ? 11 : 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</text>
    </div>
  )
}

export function IconButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  testId,
}: {
  icon: IconName
  label: string
  onClick?(): void
  active?: boolean
  disabled?: boolean
  testId?: string
}) {
  const handlers = disabled || !onClick ? {} : {
    onClick,
    onKeyDown: (event: { key?: string }) => {
      if (event.key === 'enter' || event.key === 'space') onClick()
    },
  }
  return (
    <div
      {...(testId ? { testId } : {})}
      tabIndex={disabled ? -1 : 0}
      style={{
        width: 30,
        height: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
        backgroundColor: active ? colors.sidebarActive : colors.transparent,
        opacity: disabled ? 0.35 : 1,
        userSelect: 'none',
        ...(disabled ? {} : { cursor: 'pointer', hover: { backgroundColor: colors.hover } }),
      }}
      {...handlers}
    >
      <Icon name={icon} size={16} color={active ? colors.text : colors.textMuted} />
    </div>
  )
}

export interface NativeElementHandle {
  id: number
}

export interface NativeScrollEvent {
  elementId: number
  deltaY?: number
  precise?: boolean
}

export function NativeVirtualList({
  children,
  style,
  alignment = 'top',
  followTail = false,
  overdraw,
  estimatedItemHeight,
  testId,
  onScroll,
  elementRef,
}: {
  children: React.ReactNode
  style: Record<string, unknown>
  alignment?: 'top' | 'bottom'
  followTail?: boolean
  overdraw?: number
  estimatedItemHeight?: number
  testId?: string
  onScroll?(event: NativeScrollEvent): void
  elementRef?: React.Ref<NativeElementHandle>
}) {
  return React.createElement('virtual-list', {
    alignment,
    followTail,
    overdraw,
    estimatedItemHeight,
    style,
    ...(testId ? { testId } : {}),
    ...(onScroll ? { onScroll } : {}),
    ...(elementRef ? { ref: elementRef } : {}),
  } as never, children)
}

export interface SelectOption {
  value: string
  label: string
  detail?: string
}

export function ChipSelect({
  value,
  label,
  options,
  onChange,
  testId,
  width = 190,
  icon,
  searchable = false,
}: {
  value: string
  label?: string
  options: SelectOption[]
  onChange(value: string): void
  testId?: string
  width?: number
  icon?: IconName
  searchable?: boolean
}) {
  if (searchable) return <SearchableChipSelect value={value} label={label} options={options} onChange={onChange} testId={testId} width={width} icon={icon} />
  const selected = options.find((option) => option.value === value)
  return (
    <Select value={value} onValueChange={onChange} disabled={options.length === 0}>
      <SelectTrigger
        {...(testId ? { testId } : {})}
        style={(state: SelectTriggerState) => chipTriggerStyle(state.open, width)}
      >
        <ChipSelectValue selected={selected} label={label} icon={icon} />
      </SelectTrigger>
      <SelectContent
        {...(testId ? { testId: `${testId}-content` } : {})}
        side="top"
        sideOffset={7}
        style={{
          width,
          maxHeight: 340,
          minHeight: 0,
          padding: 5,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          backgroundColor: '#171719',
          overflow: 'scroll',
        }}
      >
        {options.map((option) => <SelectOptionRow key={option.value} option={option} testId={testId} />)}
      </SelectContent>
    </Select>
  )
}

function SearchableChipSelect({ value, label, options, onChange, testId, width, icon }: {
  value: string
  label?: string | undefined
  options: SelectOption[]
  onChange(value: string): void
  testId?: string | undefined
  width: number
  icon?: IconName | undefined
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const selected = options.find((option) => option.value === value)
  const filtered = React.useMemo(() => matchSelectOptions(options, query), [options, query])
  const optionByValue = React.useMemo(() => new Map(options.map((option) => [option.value, option])), [options])
  const items = filtered.map((option) => option.value)

  return (
    <Combobox
      items={items}
      value={value}
      inputValue={query}
      open={open}
      filter={null}
      autoHighlight="always"
      disabled={options.length === 0}
      itemToStringValue={(item) => optionByValue.get(item)?.label ?? item}
      onInputValueChange={setQuery}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setQuery('')
      }}
      onValueChange={(nextValue) => {
        if (typeof nextValue === 'string') onChange(nextValue)
      }}
    >
      <ComboboxTrigger {...(testId ? { testId } : {})} style={chipTriggerStyle(open, width)}>
        <ChipSelectValue selected={selected} label={label} icon={icon} />
      </ComboboxTrigger>
      <ComboboxContent
        {...(testId ? { testId: `${testId}-content` } : {})}
        side="top"
        sideOffset={7}
        style={{ width, minHeight: 0, padding: 5, gap: 5, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#171719' }}
      >
        <div style={{ height: 34, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 9, paddingRight: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}>
          <Icon name="search" size={13} color={colors.textFaint} />
          <ComboboxInput {...(testId ? { testId: `${testId}-search` } : {})} placeholder="Search models…" style={{ minWidth: 0, flexGrow: 1, height: 30, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 11 }} />
        </div>
        <ComboboxList {...(testId ? { testId: `${testId}-list` } : {})} style={{ maxHeight: 290, minHeight: 0, overflow: 'scroll' }}>
          {(item: string) => {
            const option = optionByValue.get(item)
            return option ? <ComboboxOptionRow key={item} option={option} testId={testId} /> : null
          }}
        </ComboboxList>
        <ComboboxEmpty style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <text style={{ color: colors.textFaint, fontSize: 10 }}>No models match your search</text>
        </ComboboxEmpty>
        <text {...(testId ? { testId: `${testId}-count` } : {})} style={{ color: colors.textFaint, fontSize: 9, paddingLeft: 9, paddingBottom: 2 }}>{`${filtered.length} of ${options.length} models`}</text>
      </ComboboxContent>
    </Combobox>
  )
}

function ChipSelectValue({ selected, label, icon }: { selected: SelectOption | undefined; label?: string | undefined; icon?: IconName | undefined }) {
  return (
    <>
      {icon && <Icon name={icon} size={14} color={colors.composerControlIcon} />}
      {label && <text style={{ color: colors.composerControlIcon, fontSize: 10, fontWeight: 600, flexShrink: 0 }}>{label}</text>}
      <text style={{ color: colors.composerControlText, fontSize: 12, fontWeight: 550, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>{selected?.label ?? 'Choose'}</text>
      <Icon name="chevronDown" size={12} color={colors.composerControlIcon} />
    </>
  )
}

function SelectOptionRow({ option, testId }: { option: SelectOption; testId?: string | undefined }) {
  return (
    <SelectItem
      {...(testId ? { testId: `${testId}-option` } : {})}
      value={option.value}
      textValue={option.label}
      style={(state: SelectItemState) => optionStyle(state.highlighted || state.selected)}
    >
      {(state: SelectItemState) => <OptionText option={option} active={state.selected} />}
    </SelectItem>
  )
}

function ComboboxOptionRow({ option, testId }: { option: SelectOption; testId?: string | undefined }) {
  return (
    <ComboboxItem
      {...(testId ? { testId: `${testId}-option` } : {})}
      value={option.value}
      style={(state: ComboboxItemState) => optionStyle(state.highlighted || state.selected)}
    >
      {(state: ComboboxItemState) => <OptionText option={option} active={state.selected} />}
    </ComboboxItem>
  )
}

function OptionText({ option, active }: { option: SelectOption; active: boolean }) {
  return (
    <>
      <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 12, fontWeight: active ? 650 : 500, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{option.label}</text>
      {option.detail && <text style={{ color: colors.textFaint, fontSize: 10, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{option.detail}</text>}
    </>
  )
}

function chipTriggerStyle(open: boolean, width: number) {
  return {
    display: 'flex',
    flexDirection: 'row' as const,
    alignItems: 'center',
    gap: 6,
    height: 28,
    minWidth: 0,
    maxWidth: width,
    paddingLeft: 8,
    paddingRight: 7,
    borderRadius: 7,
    borderWidth: 0,
    backgroundColor: open ? colors.hover : colors.transparent,
    cursor: 'pointer' as const,
    userSelect: 'none' as const,
    hover: { backgroundColor: colors.hover },
  }
}

function optionStyle(active: boolean) {
  return {
    display: 'flex',
    flexDirection: 'column' as const,
    width: '100%',
    minWidth: 0,
    gap: 2,
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 9,
    paddingRight: 9,
    borderRadius: 7,
    backgroundColor: active ? colors.hover : '#171719',
    cursor: 'pointer' as const,
  }
}

export function matchSelectOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  const normalizedQuery = normalizeForSearch(query)
  if (!normalizedQuery) return [...options]
  const scored: Array<{ option: SelectOption; score: number; index: number }> = []
  options.forEach((option, index) => {
    const labelScore = fuzzyScore(normalizedQuery, normalizeForSearch(option.label))
    const detailScore = fuzzyScore(normalizedQuery, normalizeForSearch(option.detail ?? ''))
    const score = Math.max(labelScore ?? Number.NEGATIVE_INFINITY, detailScore ?? Number.NEGATIVE_INFINITY)
    if (Number.isFinite(score)) scored.push({ option, score, index })
  })
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  return scored.map(({ option }) => option)
}

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function fuzzyScore(query: string, target: string): number | undefined {
  let queryIndex = 0
  let score = 0
  let previousMatchIndex = -1
  for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
    if (target[targetIndex] !== query[queryIndex]) continue
    score += 1
    if (previousMatchIndex === targetIndex - 1) score += 0.5
    if (targetIndex === 0 || target[targetIndex - 1] === ' ' || target[targetIndex - 1] === '-') score += 0.5
    previousMatchIndex = targetIndex
    queryIndex += 1
  }
  return queryIndex === query.length ? score : undefined
}

export function Label({ children }: { children: string }) {
  return <text style={{ color: colors.textFaint, fontSize: 10, fontWeight: 650 }}>{children.toUpperCase()}</text>
}
