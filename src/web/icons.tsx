import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

export function Icon({ children, ...props }: IconProps) {
  return <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>{children}</svg>
}

export const PanelLeftIcon = (props: IconProps) => <Icon {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 4v16" /></Icon>
export const PanelRightIcon = (props: IconProps) => <Icon {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M15 4v16" /></Icon>
export const FolderIcon = (props: IconProps) => <Icon {...props}><path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon>
export const SearchIcon = (props: IconProps) => <Icon {...props}><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></Icon>
export const EditIcon = (props: IconProps) => <Icon {...props}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></Icon>
export const FolderPlusIcon = (props: IconProps) => <Icon {...props}><path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 12h5" /><path d="M14.5 9.5v5" /></Icon>
export const ChevronDownIcon = (props: IconProps) => <Icon {...props}><path d="m7 10 5 5 5-5" /></Icon>
export const PlusIcon = (props: IconProps) => <Icon {...props}><path d="M12 5v14" /><path d="M5 12h14" /></Icon>
export const CubeIcon = (props: IconProps) => <Icon {...props}><path d="m21 8-9-5-9 5 9 5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></Icon>
export const GitBranchIcon = (props: IconProps) => <Icon {...props}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v3a5 5 0 0 0 5 5h5" /><path d="M6 8v10" /></Icon>
export const BookIcon = (props: IconProps) => <Icon {...props}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z" /></Icon>
export const SettingsIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1-1.9 3.2-.2-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.3h-3.8v-.3a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.2.1-1.9-3.2.1-.1A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.3-1H3v-4h.3a1.6 1.6 0 0 0 1.3-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1 1.9-3.2.2.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5v-.3h3.8v.3a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.2-.1 1.9 3.2-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.3 1h.3v4h-.3a1.6 1.6 0 0 0-1.3 1z" /></Icon>
export const SlidersIcon = (props: IconProps) => <Icon {...props}><path d="M4 21v-7" /><path d="M4 10V3" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M20 21v-5" /><path d="M20 12V3" /><path d="M2 14h4" /><path d="M10 8h4" /><path d="M18 16h4" /></Icon>
export const PaperclipIcon = (props: IconProps) => <Icon {...props}><path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5" /></Icon>
export const ArrowUpIcon = (props: IconProps) => <Icon {...props}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></Icon>
export const BotIcon = (props: IconProps) => <Icon {...props}><path d="M12 8V4" /><rect x="5" y="8" width="14" height="10" rx="3" /><path d="M9 13h.01" /><path d="M15 13h.01" /></Icon>
export const LockOpenIcon = (props: IconProps) => <Icon {...props}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.4-2" /></Icon>
export const StopIcon = (props: IconProps) => <Icon {...props}><rect x="7" y="7" width="10" height="10" rx="1" /></Icon>
export const BellIcon = (props: IconProps) => <Icon {...props}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10 21a2 2 0 0 0 4 0" /></Icon>
export const RefreshIcon = (props: IconProps) => <Icon {...props}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></Icon>
export const DownloadIcon = (props: IconProps) => <Icon {...props}><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></Icon>
export const BoxIcon = (props: IconProps) => <Icon {...props}><path d="M21 8 12 3 3 8l9 5z" /><path d="M3 8v8l9 5 9-5V8" /></Icon>
export const PanelBottomIcon = (props: IconProps) => <Icon {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 15h16" /></Icon>
export const ClockIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></Icon>
export const CheckIcon = (props: IconProps) => <Icon {...props}><path d="m5 12 5 5 9-9" /></Icon>
export const ChevronUpIcon = (props: IconProps) => <Icon {...props}><path d="m7 14 5-5 5 5" /></Icon>
