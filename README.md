<div align="center">

# Heddlework

**Agent work, woven across harnesses.**

_A native workspace for conversations, code changes, durable work, and review — Pi first, harness-neutral by design._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/heddlework/main/media/banner.svg" alt="Animated Heddlework banner showing Pi, Codex, and Claude harness threads woven into sessions, task graphs, and review surfaces" width="100%">
</p>

[![status](https://img.shields.io/badge/status-active%20development-f59e0b?style=for-the-badge)](#project-status)
[![checks](https://img.shields.io/github/actions/workflow/status/monotykamary/heddlework/check.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/monotykamary/heddlework/actions/workflows/check.yml)
[![current harness](https://img.shields.io/badge/current%20harness-Pi-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![runtime](https://img.shields.io/badge/native%20UI-GPUIX-2563eb?style=for-the-badge)](https://github.com/remorses/gpuix)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

---

Heddlework is an agent development environment built around a simple idea: **the workspace should outlive any one agent harness**. Conversations, diffs, tasks, artifacts, review state, and workspace safety belong to the product; Pi, Codex, Claude, and future runtimes connect through adapters.

Today, Heddlework is a fast native desktop preview for [Pi](https://github.com/earendil-works/pi-coding-agent), rendered with [GPUIX](https://github.com/remorses/gpuix). The longer-term direction adds durable dependency-aware work, safe checkout lanes, scheduling, triage, and Fabric-powered orchestration without introducing another hidden agent loop.

## Project status

> [!WARNING]
> **Heddlework is under active development.** The interaction model, persistence format, adapter API, and packaging story may change. It is useful today as a source-built Pi desktop client, but it is not yet a signed or supported desktop release.

| Area | Status |
| --- | --- |
| Native desktop shell | **Available** — macOS, Linux, and Windows through GPUIX |
| Pi adapter | **Available** — Pi RPC, persisted sessions, editable queued work, models, thinking, compaction, and extension UI |
| Diff and review surfaces | **Available** — native virtualized diffs, wrapping, file filtering, and changed-file entry points |
| Fabric presentation | **Available** — rich nested `fabric_exec` activity and audit disclosures |
| Flows projection | **Preview** — queue/session rails, per-task pages, Triage, sequential and Fabric-parallel intake |
| Scheduled runtime | **Preview** — durable one-time, interval, and daily jobs that enqueue fresh Pi sessions |
| Durable dependency graph | **In design** — checkout lanes, retries, mutation receipts, and artifacts |
| Codex adapter | **Planned** |
| Claude adapter | **Planned** |
| Signed desktop distribution | **Planned** |
| Web and mobile companions | **Longer term** |

## Why Heddlework?

A heddle guides one thread inside a loom harness. Heddlework applies that model to agentic development: harness adapters carry execution, while one workspace keeps the human-visible pattern coherent.

| | Capability | What it unlocks |
| :-: | --- | --- |
| 🧵 | **Harness-neutral core** | Pi is the first adapter, not the product boundary. Codex and Claude can join without replacing session, workspace, or review concepts. |
| 💬 | **Durable conversations** | Searchable project-scoped sessions, streaming responses, reasoning, tool activity, in-session branches, explicit forks, queued steering, and compaction. |
| 🧭 | **Work lifecycle** | Active, snoozed, and settled threads with persistent navigation designed to grow into scheduled and dependency-aware work. |
| 🧩 | **Native surfaces** | Conversation, settings, notifications, changed files, and extensible right-side work surfaces in one GPU-rendered shell. |
| 🔎 | **Review without context switching** | Native virtualized diffs, wrapped lines, file filtering, mutation summaries, and artifact-oriented direction. |
| 🛡️ | **Explicit authority** | Harnesses remain authoritative for their execution and transcripts; Heddlework projects them instead of inventing a second agent loop. |

## How it fits

<p align="center">
  <img src="https://raw.githubusercontent.com/monotykamary/heddlework/main/media/architecture.svg" alt="Animated Heddlework architecture showing neutral workspace services connected to multiple harness adapters and native, web, and mobile surfaces" width="100%">
</p>

Heddlework currently launches Pi as an RPC sidecar. The transport boundary in `src/pi/transport.ts` is intentionally small; future harness adapters can implement the same application-facing contract while preserving their own execution semantics.

## Install today: source preview

Requirements:

- [pnpm](https://pnpm.io) 11+
- [Bun](https://bun.sh) 1.3+ as the application runtime
- a working `pi` executable on `PATH`
- a platform supported by GPUIX: macOS, Linux, or Windows

```bash
git clone https://github.com/monotykamary/heddlework.git
cd heddlework
bun install --frozen-lockfile
bun run start -- /path/to/repository
```

For UI development without credentials or a Pi process:

```bash
bun run demo -- /path/to/repository
```

For hot reload:

```bash
bun run dev -- /path/to/repository
```

Build the current unsigned executable:

```bash
bun run build
./dist/heddlework /path/to/repository
```

### Linux desktop integration

Linux users can install the current unsigned build into their user application menu:

```bash
bun run build
HEDDLEWORK_PI="$(command -v pi)" ./packaging/linux/install-user.sh
```

The installer uses the standalone executable, a square scalable icon, and an absolute-path launcher so app-grid launches do not depend on the GUI session inheriting Bun or Pi from shell startup files. See [Linux desktop integration](packaging/linux/README.md) for installed paths, GNOME cache guidance, removal, and diagnostic-log precautions.

### Queue behavior

Submitting while an agent run is active stages the input in Heddlework's editable queue instead of immediately surrendering it to Pi's immutable RPC queue. **Enter** creates a steering row for the next healthy turn boundary; the visible **Queue** action and **Option/Alt+Enter** create a follow-up for `agent_settled`. While idle, ordinary **Enter** still starts immediately, **Queue** parks work in a paused plan, and **Enter** on an empty composer—or the primary action—resumes its oldest row. The collapsed strip is inset like an upside-down checkout bar and tucks behind the composer; expanding it springs upward into a single bounded scroll surface where rows can be edited, held, removed, moved between lanes, explicitly steered, or reordered from their left drag handles.

Steering drains one row at a healthy `turn_end`; follow-ups drain one row after `agent_settled`, and lane-local FIFO order is preserved. A row hold blocks only its own lane. Delivery holds during compaction. Abort pauses the remaining tail until **Resume** is selected, while the controller's graceful pause waits for in-flight tools before stopping Pi. A terminal error also holds the tail, but a healthy retry or overflow-compaction recovery releases it automatically; otherwise it remains available for manual resume. Skills, prompt templates, and extension commands remain raw until Pi accepts them. Every built-in slash command is a queue barrier and is intercepted by Heddlework whether submitted idle or queued, so `/name`, `/compact`, `/new`, and similar controls are never collapsed into model prompts. A queued `/new` waits for its parent run to settle and starts a child-linked Pi session before the lane continues. Image-bearing slash text remains a normal message so attachments are never discarded. The Fabric gate in the queue strip selects live peers and inserts a cancellable `/fabric await` barrier through an input-only bridge; it does not inject model context. The owned queue is persisted per workspace. Stable rows, Flow correlation, lane identity, row holds, pause state, and images survive restart; if the process stopped during an uncertain dispatch, restoration pauses with a recovery hold instead of risking a duplicate control or prompt. Pi-native steering and follow-up entries are still mirrored as locked rows because RPC does not expose mutation operations for them.

### Flows

**Flows** is a full-page read-only projection opened from the button above Search. **Work** merges every Heddlework-owned queue row with ordinary, scheduled, and historical Flow-named Pi sessions. Steer and follow-up lanes become sequential rail groups immediately: messages are tasks, `/new` is a pending session handoff, and `/fabric await` branches onto a connected peer-gate lane before rejoining the queue. After a handoff runs, Pi's own `parentSession` metadata keeps the resulting sessions on the same causal rail. **Queue in chat** returns to the fresh/current thread composer instead of opening a separate task form, so manual work has no Flow definition or lifecycle record. A task page shows the projected prompt or control, remaining queue primitives, current Fabric workers, and Pi result. Sessions older than seven days collapse into **Settled** until they run again or the user restores them. **Triage** derives successful and failed entries from terminal assistant stop reasons and tracks local read receipts. Pi remains authoritative for status and output; Heddlework stores only presentation annotations—settle/unsettle receipts, optional priority overrides, and user labels. Automatic priority rises with session duration.

Parallel work is also observational: any Pi session fans into agent rails only when `fabric_exec` reports participant previews or completed agent audits. It does not require a Flow name, managed child sessions, extra tools, or context markers. A user can queue an ordinary orchestration prompt from chat; scheduled parallel jobs still compile one prompt that asks Pi Fabric to spawn and join concurrent workers, while Fabric remains the execution authority.

**Scheduled** stores one-time, interval, and daily job definitions in the Heddlework runtime. Each due occurrence becomes the same queue primitives and a fresh Pi session, so schedules own intent while Pi sessions remain run history. The desktop runtime must be running; an occurrence for a different active workspace remains durably pending until that workspace runtime is available.

### Pi slash commands

Pi RPC's `get_commands` response intentionally excludes built-in TUI commands, so Heddlework adds Pi's complete built-in command catalog to native completion and gives built-ins precedence over conflicting extension names. RPC-backed commands cover model and thinking changes, HTML export, session naming and stats, forking and cloning, new sessions, compaction with custom instructions, and resource reload. Host-backed commands open Heddlework's settings, model, thinking, resume, and session-tree surfaces, copy the last response, or quit cleanly. Prompt templates, skills, `/llama`, and other extension commands continue through Pi's `prompt` RPC so Pi performs their normal expansion or command handler.

Pi RPC exposes the full session tree through `get_tree`, but not the mutating half of `/tree`. Heddlework reads that tree natively and delegates selections through a control-only extension to Pi core's `ExtensionCommandContext.navigateTree()`, the same in-place navigation path used by the TUI. Active transcript paging starts from Pi's `leafId`, so switching branches keeps the session file and ID while restoring the selected branch. See [Pi session tree integration](docs/pi-session-tree.md).

Pi does not currently expose RPC operations for `/scoped-models`, `/import`, `/share`, `/trust`, `/login`, `/logout`, `/hotkeys`, or `/changelog`. Heddlework recognizes these commands and reports the protocol limitation instead of sending their text to the model. Authentication and trust changes can still be made from interactive Pi before reconnecting Heddlework.

### Pi extension UI

Extension interactions are hosted in the main conversation area rather than embedded in the composer. Heddlework queues concurrent requests, shows searchable described choices and timeout countdowns, renders extension statuses, discovers slash commands, and retains visible custom-message media. Known contracts add a full tabbed `ask_user_question` questionnaire and recursive `/fabric settings` navigation without moving execution or persistence authority out of Pi. See [Pi extension UI](docs/pi-extension-ui.md).

## Install later: product channels

These channels describe the intended distribution path; they are **not available yet**.

| Channel | Intended path |
| --- | --- |
| Desktop | Signed and notarized macOS, Windows, and Linux downloads from GitHub Releases, followed by native package-manager channels |
| Web | An installable browser/PWA client connected to a local or remote Heddlework host |
| Mobile | Companion clients for steering, approvals, notifications, task triage, and artifact review |

The desktop application remains the primary environment for local repositories, terminals, worktrees, and native agent processes. Web and mobile are planned as additional surfaces over the same workspace model, not separate products.

## Current workflow

1. **Open a repository** — pass a path or use the native directory picker.
2. **Choose or resume work** — Heddlework discovers persisted Pi sessions across projects without eagerly loading full transcripts.
3. **Collaborate** — prompt, steer, abort, switch models, adjust thinking, paste images, and answer extension dialogs.
4. **Inspect execution** — expand reasoning, ordinary tools, and nested Fabric activity without leaving the timeline.
5. **Review changes** — open the working-tree diff, filter files, wrap long lines, and keep large patches virtualized.
6. **Organize the result** — snooze or settle threads and review persistent notification history.

## Configuration

If Pi is not discoverable from the desktop application environment:

```bash
HEDDLEWORK_PI=/absolute/path/to/pi bun run start -- /path/to/repository
```

| Variable | Purpose |
| --- | --- |
| `HEDDLEWORK_CWD` | Workspace path instead of the positional argument |
| `HEDDLEWORK_PI` | Absolute Pi executable path (recommended for desktop launchers) |
| `HEDDLEWORK_PROVIDER` | Initial provider passed to Pi |
| `HEDDLEWORK_MODEL` | Initial model passed to Pi |
| `HEDDLEWORK_SESSION` | Pi session file to resume |
| `HEDDLEWORK_NO_SESSION=1` | Disable Pi session persistence |
| `HEDDLEWORK_DEMO=1` | Use the deterministic no-credentials demo transport |
| `HEDDLEWORK_DEBUG_OVERLAY=full` | Show GPUIX frame timings (`minimal` is also supported) |

## Architecture

Heddlework follows a small supervised component model inspired by Cordis:

- `src/core/kernel.ts` owns deferred service injection, typed events, keyed contributions, dependent lifetimes, and reverse-order cleanup.
- `src/workbench/plugins.ts` composes transport, session discovery, workspace diff, and controller capabilities without giving the controller concrete providers to construct.
- `src/pi/transport.ts` defines the application-facing harness transport seam; Pi RPC is its first provider.
- `src/workbench/controller.ts` projects harness events into UI state, owns the durable delivery queue, and rehydrates from authoritative transcripts.
- `src/flows/runtime.ts` persists schedule intent and compiles due occurrences into the same queue primitives authored directly in chat.
- `src/flows/projection.ts` derives Work and Triage from queue rows and Pi session summaries without a task lifecycle database; `src/flows/fabric-projection.ts` derives parallel branches from Fabric participant audits; `src/workbench/thread-metadata-store.ts` persists only local disposition, read, priority, and label annotations.
- `src/plugin-api.ts` is the narrow source-level facade for feature authors.
- `src/ui/extensions.ts` hosts observable, reversible feature manifests; one plugin can contribute several native workbench surfaces.
- `src/ui/core-extension.tsx` registers the shipped surfaces through the same contract available to future user plugins.
- `src/ui/tool-presenters.ts` remains a keyed presentation contribution slot.
- `src/ui/transcript-projection.ts` turns loaded transcript semantics into stable, progressively disclosed native rows; see [Transcript projection](docs/transcript-projection.md).
- `src/ui/` contains the shared GPUIX shell and never owns harness execution truth.

The UI boundary is intentionally not a microfrontend platform: extensions share one React/GPUIX runtime and register coarse feature surfaces rather than independent applications or a plugin per visual element. See [UI extensions](docs/ui-extensions.md).

### Cordis invariants

Heddlework applies the two dimensions from *A Programming Paradigm for Spatiotemporal Composability* at capability boundaries:

- **Temporal composability:** every registration, listener, timer, process, and other owned effect has an inverse attached to the same plugin, controller, or React lifecycle. Unloading the owner withdraws those effects in reverse order; operations outside the process boundary use their protocol's cancellation or compensation semantics.
- **Spatial composability:** replaceable capabilities are typed services, consumers declare them through `requires`, and providers are constructed only by provider plugins or the composition root. Internal collaborators receive narrow interfaces or props rather than locating providers globally.
- **Component granularity:** a Cordis component is an independently loadable capability or integration, not every source file or React component. Cohesive UI implementation may be split into static modules while remaining under one feature lifecycle; new plugins and contribution seats require an independently replaceable behavior and a demonstrated consumer.

Pi remains authoritative for Pi messages and sessions. Streaming state is temporary and replaced by `get_messages` after completion. Future adapters must preserve the same authority rule for their harnesses.

## Roadmap

- [x] Native GPU-rendered desktop shell
- [x] Pi RPC adapter and persisted-session browser
- [x] Streaming conversation, tools, images, extension UI, and notifications
- [x] Virtualized transcript and large-diff paths
- [x] Diff, settings, notification, and surface shells
- [x] Cordis-style service/event lifetimes and in-process UI surface manifests
- [ ] External plugin discovery and compatibility metadata
- [ ] Stable harness adapter protocol
- [ ] Codex and Claude adapters
- [x] Projection-first Flows with chat-authored sequential queues, participant-truth Fabric graphs, task pages, and Triage
- [x] Durable one-time, interval, and daily scheduled Flow runtime
- [ ] Durable dependency graphs and safe checkout lanes
- [ ] Mutation receipts and artifact review
- [ ] Signed desktop installers and automatic updates
- [ ] Web workspace client
- [ ] Mobile companion clients

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

The native test suite exercises the real GPUIX reconciler and covers shell interactions, session paging, transcript following, clipboard media, extension dialogs, notifications, native diff virtualization, deep-scroll performance, and spring panel geometry.

## Acknowledgments

- The desktop layout and interaction language adapt the MIT-licensed [T3 Code](https://github.com/pingdotgg/t3code) interface.
- Icons include paths adapted from [Lucide](https://github.com/lucide-icons/lucide).
- Pi integration targets [Pi](https://github.com/earendil-works/pi-coding-agent).
- Native rendering is provided by [GPUIX](https://github.com/remorses/gpuix).

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for complete attribution.

## License

MIT
