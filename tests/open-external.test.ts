import { describe, expect, it } from 'bun:test'
import { directoryPickerCommand } from '../src/ui/open-external.ts'

describe('workspace directory picker', () => {
  it('uses each platform native folder chooser instead of a path text form', () => {
    expect(directoryPickerCommand('darwin')).toMatchObject({ command: '/usr/bin/osascript' })
    expect(directoryPickerCommand('darwin')?.args.join(' ')).toContain('choose folder')
    expect(directoryPickerCommand('win32')).toMatchObject({ command: 'powershell.exe' })
    expect(directoryPickerCommand('win32')?.args.join(' ')).toContain('FolderBrowserDialog')
    expect(directoryPickerCommand('linux')).toEqual({ command: 'zenity', args: ['--file-selection', '--directory', '--title=Open project in Heddlework'] })
  })
})
