# Harness adapter protocol

Protocol version 1. Everything here lives in `src/protocol/` and is re-exported from `src/plugin-api.ts`.

## Authority rule

A harness owns its execution and its transcript. Heddlework projects that truth into `WorkbenchState` and never runs a second agent loop. Every adapter and every remote surface inherits this rule: commands request work from the harness, and state flows back only from harness events.

## Adapter contract

`HarnessAdapter` (`src/protocol/adapter.ts`) extends the transport seam in `src/pi/transport.ts` with three fields.

| Field | Meaning |
| --- | --- |
| `id` | Stable machine name, for example `pi-rpc` or `demo` |
| `displayName` | Human label shown in settings |
| `capabilities` | `HarnessCapabilities` flags so surfaces can hide controls the harness cannot honor |

`HarnessCapabilities` covers `sessions`, `sessionTree`, `queueMirror`, `models`, `thinking`, `compaction`, `extensionUi`, `fork`, and `export`. `describePiAdapter()` returns the Pi set, which is all true. `isHarnessAdapter(value)` is the structural check used by tests and plugin loaders.

The execution methods stay the same as `AgentTransport`: `start`, `stop`, `request`, `send`, `onEvent`, `onStatus`, `getStderr`. A future adapter for another harness implements this interface and is mounted through `createAgentTransportPlugin` or a sibling provider plugin.

## Commands

`WorkbenchCommand` (`src/protocol/commands.ts`) is a discriminated union on `type`. Each member maps to one public `WorkbenchController` method with plain JSON arguments. `applyWorkbenchCommand(controller, command)` performs the dispatch. Lookups that need an object the wire cannot carry, such as `setModel` and `switchSession`, resolve by identity against the current snapshot and throw `Unknown model` or `Unknown session` when the target is absent.

`WORKBENCH_COMMAND_TYPES` lists every accepted `type` and `isWorkbenchCommand` validates an incoming value before dispatch.

## Snapshots and patches

`serializeSnapshot(state)` produces a `WorkbenchSnapshot`, which is `WorkbenchState` with composer image bytes above `SNAPSHOT_IMAGE_LIMIT_BYTES` (256 KiB) replaced by `{ omitted: true, bytes }`. `diffSnapshots(previous, next)` returns a `SnapshotPatch` holding only the top-level keys whose reference changed, and `applySnapshotPatch` merges it back. Remote surfaces receive one full snapshot on connect and patches after that.

## Wire messages

`ClientMessage` is `hello`, `command` (with a numeric `id`), or `ping`. `ServerMessage` is `welcome` (protocol, workspace path, snapshot, flow runtime snapshot, and optional `hostUrls` listing every base URL a remote client can reach this host on so it can rotate when one path drops), `patch`, `flows`, `result` (matched to a command `id`), `error`, or `pong`. `parseClientMessage` and `parseServerMessage` accept raw strings or objects and return `undefined` on malformed input.

## Browser safety

The protocol modules and the projection layer they depend on (`src/flows/types.ts`, `src/flows/projection.ts`, `src/ui/transcript-projection.ts`, `src/workbench/queue.ts`, `src/workbench/state.ts`, `src/workbench/timeline.ts`) contain no `node:` imports. `tests/protocol-browser-safe.test.ts` bundles them with `Bun.build({ target: 'browser' })` and fails if a Node specifier appears, which keeps the web and mobile clients buildable.

## Versioning

`PROTOCOL_VERSION` is `1`. Adding an optional field to a command or snapshot key keeps the version. Removing or renaming a command, or changing the meaning of a snapshot key, bumps it and the host must refuse `hello` messages with an older number.
