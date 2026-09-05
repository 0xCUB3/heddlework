import { describe, expect, it } from 'bun:test'
import { directoryPickerCommand, directoryPickerCommands, systemTargetCommand } from '../src/ui/open-external.ts'

describe('external targets', () => {
  it('passes Windows URLs as one argument without invoking a command shell', () => {
    const target = 'https://example.com/?next=a&then=b|c'
    expect(systemTargetCommand(target, 'win32')).toEqual({ command: 'explorer.exe', args: [target] })
    expect(systemTargetCommand(target, 'darwin')).toEqual({ command: '/usr/bin/open', args: [target] })
  })
})

describe('workspace directory picker', () => {
  it('uses each platform native folder chooser instead of a path text form', () => {
    expect(directoryPickerCommand('darwin')).toMatchObject({ command: '/usr/bin/osascript' })
    expect(directoryPickerCommand('darwin')?.args.join(' ')).toContain('choose folder')
    expect(directoryPickerCommand('win32')).toMatchObject({ command: 'powershell.exe' })
    expect(directoryPickerCommand('win32')?.args.join(' ')).toContain('FolderBrowserDialog')
    expect(directoryPickerCommand('linux')).toEqual({ command: 'zenity', args: ['--file-selection', '--directory', '--title=Open project in Heddlework'] })
  })

  it('falls back from zenity to kdialog on Linux for Wayland sessions without zenity', () => {
    const pickers = directoryPickerCommands('linux')
    expect(pickers).toHaveLength(2)
    expect(pickers[0]).toMatchObject({ command: 'zenity' })
    expect(pickers[1]).toMatchObject({ command: 'kdialog' })
    expect(pickers[1]?.args).toContain('--getexistingdirectory')
  })

  it('offers a single picker on macOS and Windows', () => {
    expect(directoryPickerCommands('darwin')).toHaveLength(1)
    expect(directoryPickerCommands('win32')).toHaveLength(1)
  })
})