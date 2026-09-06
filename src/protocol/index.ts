export { PROTOCOL_VERSION, type ProtocolVersion } from './version.ts'
export { describePiAdapter, isHarnessAdapter, type HarnessAdapter, type HarnessCapabilities } from './adapter.ts'
export {
  applyWorkbenchCommand,
  isSleepPreventionCommand,
  isWorkbenchCommand,
  SLEEP_PREVENTION_COMMAND_TYPES,
  WORKBENCH_COMMAND_TYPES,
  type SleepPreventionCommand,
  type WorkbenchCommand,
  type WorkbenchCommandType,
} from './commands.ts'
export {
  applySnapshotPatch,
  diffSnapshots,
  isPatchEmpty,
  serializeSnapshot,
  SNAPSHOT_IMAGE_LIMIT_BYTES,
  type OmittedImageData,
  type SnapshotComposerImage,
  type SnapshotKey,
  type SnapshotPatch,
  type WorkbenchSnapshot,
} from './snapshot.ts'
export { parseClientMessage, parseServerMessage, type AttentionEvent, type ClientMessage, type ServerMessage } from './messages.ts'
export {
  encodeFrames,
  FrameAssembler,
  isWireFrame,
  MAX_ASSEMBLED_BYTES,
  MAX_WS_FRAME_BYTES,
  splitUtf8,
  utf8ByteLength,
  type WireFrame,
} from './frames.ts'
export {
  applyTerminalCommand,
  clampTerminalCols,
  clampTerminalRows,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  isTerminalCommand,
  MAX_TERMINAL_WRITE_CHARS,
  TERMINAL_COMMAND_TYPES,
  type RemoteTerminalFrame,
  type RemoteTerminalSession,
  type RemoteTerminalSnapshot,
  type TerminalCommand,
  type TerminalCommandTarget,
} from './terminal.ts'
