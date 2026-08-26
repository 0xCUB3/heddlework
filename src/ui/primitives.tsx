import React from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  type SelectItemState,
  type SelectTriggerState,
} from '@gpuix/react'
import { colors } from './theme.ts'

export interface ButtonProps {
  label: string
  onClick?: () => void
  disabled?: boolean
  tone?: 'default' | 'primary' | 'danger' | 'quiet'
  testId?: string
  compact?: boolean
}

export function Button({ label, onClick, disabled = false, tone = 'default', testId, compact = false }: ButtonProps) {
  const palette = tone === 'primary'
    ? { background: colors.accent, foreground: '#11140E', border: colors.accent }
    : tone === 'danger'
      ? { background: '#3B2024', foreground: colors.error, border: '#583038' }
      : tone === 'quiet'
        ? { background: colors.transparent, foreground: colors.textMuted, border: colors.transparent }
        : { background: colors.raised, foreground: colors.text, border: colors.border }
  return (
    <div
      {...(testId ? { testId } : {})}
      tabIndex={disabled ? -1 : 0}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: compact ? 26 : 32,
        paddingLeft: compact ? 9 : 12,
        paddingRight: compact ? 9 : 12,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
        opacity: disabled ? 0.45 : 1,
        userSelect: 'none',
        ...(disabled ? {} : { cursor: 'pointer', hover: { backgroundColor: tone === 'primary' ? '#C8FF85' : colors.hover } }),
      }}
      {...(disabled ? {} : {
        onClick,
        onKeyDown: (event: { key?: string }) => {
          if (event.key === 'enter' || event.key === 'space') onClick?.()
        },
      })}
    >
      <text style={{ color: palette.foreground, fontSize: compact ? 11 : 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {label}
      </text>
    </div>
  )
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
}: {
  value: string
  label: string
  options: SelectOption[]
  onChange(value: string): void
  testId?: string
  width?: number
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={options.length === 0}>
      <SelectTrigger
        {...(testId ? { testId } : {})}
        style={(state: SelectTriggerState) => ({
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          height: 28,
          minWidth: 0,
          maxWidth: width,
          paddingLeft: 9,
          paddingRight: 8,
          borderRadius: 7,
          borderWidth: 1,
          borderColor: state.open ? colors.borderStrong : colors.border,
          backgroundColor: state.open ? colors.hover : colors.raised,
          cursor: 'pointer',
          userSelect: 'none',
          hover: { backgroundColor: colors.hover },
        })}
      >
        <text style={{ color: colors.textMuted, fontSize: 10, fontWeight: 600, flexShrink: 0 }}>{label}</text>
        <text style={{ color: colors.text, fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>
          {options.find((option) => option.value === value)?.label ?? 'Choose'}
        </text>
        <text style={{ color: colors.textFaint, fontSize: 10, flexShrink: 0 }}>⌄</text>
      </SelectTrigger>
      <SelectContent
        side="top"
        sideOffset={6}
        style={{
          width,
          maxHeight: 320,
          padding: 5,
          borderRadius: 9,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          backgroundColor: '#202329',
        }}
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            textValue={option.label}
            style={(state: SelectItemState) => ({
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingTop: 7,
              paddingBottom: 7,
              paddingLeft: 9,
              paddingRight: 9,
              borderRadius: 6,
              backgroundColor: state.highlighted || state.selected ? colors.hover : '#202329',
              cursor: 'pointer',
            })}
          >
            {(itemState) => (
              <>
                <text style={{ color: itemState.selected ? colors.accent : colors.text, fontSize: 12, fontWeight: itemState.selected ? 600 : 500 }}>
                  {option.label}
                </text>
                {option.detail && <text style={{ color: colors.textFaint, fontSize: 10 }}>{option.detail}</text>}
              </>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function Label({ children }: { children: string }) {
  return <text style={{ color: colors.textFaint, fontSize: 10, fontWeight: 700 }}>{children.toUpperCase()}</text>
}
