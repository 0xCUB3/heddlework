import React from 'react'
import {
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
}: {
  value: string
  label?: string
  options: SelectOption[]
  onChange(value: string): void
  testId?: string
  width?: number
  icon?: IconName
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <Select value={value} onValueChange={onChange} disabled={options.length === 0}>
      <SelectTrigger
        {...(testId ? { testId } : {})}
        style={(state: SelectTriggerState) => ({
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          height: 28,
          minWidth: 0,
          maxWidth: width,
          paddingLeft: 8,
          paddingRight: 7,
          borderRadius: 7,
          borderWidth: 0,
          backgroundColor: state.open ? colors.hover : colors.transparent,
          cursor: 'pointer',
          userSelect: 'none',
          hover: { backgroundColor: colors.hover },
        })}
      >
        {icon && <Icon name={icon} size={14} color={colors.textMuted} />}
        {label && <text style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, flexShrink: 0 }}>{label}</text>}
        <text style={{ color: colors.textMuted, fontSize: 12, fontWeight: 550, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>
          {selected?.label ?? 'Choose'}
        </text>
        <Icon name="chevronDown" size={12} color={colors.textFaint} />
      </SelectTrigger>
      <SelectContent
        side="top"
        sideOffset={7}
        style={{
          width,
          maxHeight: 340,
          padding: 5,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          backgroundColor: '#171719',
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
              borderRadius: 7,
              backgroundColor: state.highlighted || state.selected ? colors.hover : '#171719',
              cursor: 'pointer',
            })}
          >
            {(itemState: SelectItemState) => (
              <>
                <text style={{ color: itemState.selected ? colors.text : colors.textMuted, fontSize: 12, fontWeight: itemState.selected ? 650 : 500 }}>
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
  return <text style={{ color: colors.textFaint, fontSize: 10, fontWeight: 650 }}>{children.toUpperCase()}</text>
}
