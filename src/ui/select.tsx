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
} from '@gpuix/react'
import { Icon, type IconName } from './icons.tsx'
import { colors } from './theme.ts'

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
  triggerMaxWidth = width,
  icon,
  searchable = false,
  onOpenChange,
  openRequest,
}: {
  value: string
  label?: string
  options: SelectOption[]
  onChange(value: string): void
  testId?: string
  width?: number
  triggerMaxWidth?: number
  icon?: IconName
  searchable?: boolean
  onOpenChange?(open: boolean): void
  openRequest?: number
}) {
  if (searchable) return <SearchableChipSelect value={value} label={label} options={options} onChange={onChange} {...(onOpenChange ? { onOpenChange } : {})} {...(openRequest === undefined ? {} : { openRequest })} testId={testId} width={width} triggerMaxWidth={triggerMaxWidth} icon={icon} />
  const [open, setOpen] = React.useState(false)
  const selected = options.find((option) => option.value === value)
  const optionByValue = React.useMemo(() => new Map(options.map((option) => [option.value, option])), [options])
  const items = options.map((option) => option.value)
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }
  React.useEffect(() => {
    if (openRequest !== undefined) handleOpenChange(true)
  }, [openRequest])
  return (
    <Combobox
      items={items}
      value={value}
      open={open}
      filter={null}
      autoHighlight="always"
      disabled={options.length === 0}
      itemToStringValue={(item) => optionByValue.get(item)?.label ?? item}
      onOpenChange={handleOpenChange}
      onValueChange={(nextValue) => {
        if (typeof nextValue === 'string') onChange(nextValue)
      }}
    >
      <ComboboxTrigger {...(testId ? { testId } : {})} style={chipTriggerStyle(open, triggerMaxWidth)}>
        <ChipSelectValue selected={selected} label={label} icon={icon} />
      </ComboboxTrigger>
      <ComboboxContent
        {...(testId ? { testId: `${testId}-content` } : {})}
        side="top"
        sideOffset={7}
        style={{ width, maxHeight: 340, minHeight: 0, padding: 5, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover, overflow: 'scroll' }}
      >
        <ComboboxList style={{ maxHeight: 330, minHeight: 0, overflow: 'scroll' }}>
          {(item: string) => {
            const option = optionByValue.get(item)
            return option ? <ComboboxOptionRow key={item} option={option} testId={testId} /> : null
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

function SearchableChipSelect({ value, label, options, onChange, onOpenChange, openRequest, testId, width, triggerMaxWidth, icon }: {
  value: string
  label?: string | undefined
  options: SelectOption[]
  onChange(value: string): void
  onOpenChange?(open: boolean): void
  openRequest?: number | undefined
  testId?: string | undefined
  width: number
  triggerMaxWidth: number
  icon?: IconName | undefined
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const selected = options.find((option) => option.value === value)
  const filtered = React.useMemo(() => matchSelectOptions(options, query), [options, query])
  const optionByValue = React.useMemo(() => new Map(options.map((option) => [option.value, option])), [options])
  const items = filtered.map((option) => option.value)
  React.useEffect(() => {
    if (openRequest === undefined) return
    setOpen(true)
    onOpenChange?.(true)
  }, [openRequest])

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
        onOpenChange?.(nextOpen)
        if (!nextOpen) setQuery('')
      }}
      onValueChange={(nextValue) => {
        if (typeof nextValue === 'string') onChange(nextValue)
      }}
    >
      <ComboboxTrigger {...(testId ? { testId } : {})} style={chipTriggerStyle(open, triggerMaxWidth)}>
        <ChipSelectValue selected={selected} label={label} icon={icon} />
      </ComboboxTrigger>
      <ComboboxContent
        {...(testId ? { testId: `${testId}-content` } : {})}
        side="top"
        sideOffset={7}
        style={{ width, minHeight: 0, padding: 5, gap: 5, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover }}
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
    backgroundColor: active ? colors.hover : colors.popover,
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
