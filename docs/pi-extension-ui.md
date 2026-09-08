# Pi extension UI

Heddlework runs Pi as an ordinary RPC sidecar, so installed Pi extensions remain authoritative for commands, tools, configuration, and session behavior. The native host projects the semantic RPC UI protocol rather than importing terminal components into the desktop process.

## Native RPC surfaces

Heddlework handles Pi's `select`, `confirm`, `input`, and `editor` requests in the main conversation area. Requests are queued by ID instead of replacing one another, retain independent timeout deadlines, and are cancelled together when their owning session closes. Choice lists are vertical, searchable when long, and preserve the exact wire value while presenting numbered labels, descriptions, and current values separately. Interactive option and settings rows are divider-free and use the same rounded hover fill as session cards. Session-only pi-ledger engagement prompts are dismissed in an empty draft and appear only after a conversation is active.

Fire-and-forget extension surfaces are also native:

- `notify` and `extension_error` enter the notification stack and ledger.
- String `setWidget` content and ANSI-safe `setStatus` entries share a horizontally scrollable rail above the composer. Above-editor widgets enter first, followed by below-editor widgets and then status chips; new items use that same order for staggered motion.
- `setTitle` updates the window title.
- `setEditorText` updates the draft.
- `get_commands` powers discovery for extension commands, prompt templates, and skills. Heddlework merges Pi's built-in command catalog locally because RPC intentionally omits TUI commands.

Visible custom messages retain text, extension source, and image blocks in the transcript. Tool calls retain their raw arguments, results, and details for keyed native presenters.

## Structured native questions

Heddlework does not whitelist tool names. A running tool becomes a native question when its arguments match a JSON-safe shape:

- `{ question, options?, details?, multiSelect? }` — one stem, optional description, single-select, multi-select, or free text.
- `{ questions: [{ question, header, options, multiSelect? }] }` — the tabbed package questionnaire.

Stable wire `value`s stay distinct from rendered `label`s. Markdown, including `$...$` math, is rendered in the stem, description, and option labels. Optional fields appear only when the schema actually carries them:

- `correctAnswer` / `explanation` mark a graded quiz: native **I don't know** and **Note (optional)**. Those authoring fields are never shown.
- Otherwise, options get a custom-answer path.
- Unknown/skip is not invented for schemas that do not permit it.

The live-bridge advertises `heddlework.question.v1` on session state and as `globalThis[Symbol.for("heddlework.native.question.v1")]`. Extensions may call `ask(question)` for an explicit host round-trip. That call is the contract: `ask` must return the declared answer shape (`custom-quiz`, `custom-ask`, or `{ type, label, value }` text). Tool argument shape is how Heddlework *discovers* a question, not a way to infer an arbitrary `ctx.ui.custom()` factory's return type. Adapters (`formatCustomResult` / `customUiResultFromAnswer`) only build those declared shapes. If the host already sends `answer.result`, that value is authoritative.

Each invocation mints its own `requestId` and keeps `toolCallId` as a separate field. Waiters are keyed by `requestId`. A remote answer may cite `toolCallId` only when exactly one waiter owns that tool. The bridge never binds a `custom()` call to the most recently started question-shaped tool. Provenance is, in order: explicit `heddlework.question.v1` metadata on the call, per-tool `AsyncLocalStorage` around `execute` when `registerTool` was wrapped, or exactly one unbound running question-shaped tool. Overlay `custom()` calls and anything else without that provenance get the visible **terminal-only extension UI** fallback and do not cancel a question that is already waiting.

In RPC mode, Q&A-shaped `ctx.ui.custom()` calls that *do* have provenance are translated into `select` / `input` / `editor` so the waiting extension still resumes. In an attached TUI session the original custom UI stays on the owner terminal; answering from Heddlework completes that same `done()` once, without injecting a chat message. Remote answers that arrive before the TUI factory runs still settle the waiter; the factory is closed with that same result when it later starts. Local and remote are one-shot: the loser is cancelled, `done()` is not called twice, and tool-end / session close clean up the waiter.

Answers keep `requestId` / `toolCallId` correlation, reject duplicates after submit or reconnect, and cannot be applied to a later question with the same surface. Graded project quizzes preserve shuffled display order and 1-based option indices so grading stays correct; `correctAnswer` and `explanation` are never shown in the native UI.

## Known adapters

### Pi Fabric

`pi-fabric` exposes its complete `/fabric settings` hierarchy through the standard RPC dialog primitives. The root shows the active project or global save layer. Every existing section, inline value, nested section, numeric or string input, model selector, list editor, and compaction threshold remains backed by Fabric's existing persistence and coercion callbacks. Selecting Back returns one level; leaving the root applies the same reload and notification behavior as the TUI. Fabric programs that call a Q&A-shaped tool, whatever its name, use the structured question path above rather than a Fabric-specific widget parser.

### Tabbed questionnaires

When a running tool with a `questions[]` array and its first RPC request agree on the authored question, Heddlework presents one native questionnaire instead of sequential dialogs. It supports question tabs, single and multiple choices, custom answers, Markdown previews, a review tab, cancellation, and hide/reopen behavior. The questionnaire covers the complete conversation page with an opaque surface. Hiding moves a compact waiting control directly above the composer and expands the transcript spacer by the same height, so the control never covers the final conversation rows. Submission is translated back into the package's exact sequential select/input responses; unexpected request methods or question text are not guessed.

The package's RPC fallback does not carry per-question notes or a global note, so the native adapter does not expose controls that would silently discard them. Graded project-local quizzes that do carry a note field use the structured question path instead.

## Protocol boundary

Arbitrary `ctx.ui.custom()` factories, custom editors, footers, headers, and TUI renderer closures do not cross Pi RPC. Heddlework cannot safely translate those imperative in-process components into React/GPUIX automatically. Snake, Doom, overlay games, and any custom renderer that does not publish `heddlework.question.v1` metadata stay in the terminal. The host shows a visible **terminal-only extension UI** fallback rather than guessing from ANSI.

Exact support requires either:

- Q&A-shaped tool arguments or `ctx.ui.select` / `confirm` / `input` / `editor`, or
- the advertised `heddlework.question.v1` contract.

Pi also labels desktop-submitted prompts as `source: "rpc"`. Extensions that require terminal keystrokes or `source: "interactive"`, such as pi-ledger's first-keystroke and steering metering, still need a host-input provenance contract. Heddlework renders pi-ledger's status and dialogs, but does not claim that missing behavioral signal is restored.
