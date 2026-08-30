# Pi session tree integration

Heddlework treats Pi's session tree as harness-owned state. It does not rewrite session JSONL or emulate branching in application storage.

## Authority and data flow

1. `get_tree` provides the complete append-only tree and Pi's current `leafId`.
2. Heddlework projects those nodes into a searchable native picker. The active leaf and persisted labels stay visible.
3. A selection is sent through Heddlework's control-only Pi extension.
4. The extension calls `ExtensionCommandContext.navigateTree()`, the same `AgentSession.navigateTree()` path used by Pi's TUI.
5. Heddlework reloads messages from the leaf returned by Pi. The session file and session ID do not change.

The bridge exists because Pi RPC exposes `get_tree` but does not currently expose a mutating tree-navigation command. Its private extension command is removed from Heddlework's slash-command catalog and never adds model context or a model-callable tool.


## Tree picker views

The native picker starts with Pi core's tree projections and adds a symmetric assistant-only role view instead of exposing one permanently flattened list:

- **Default** hides settings and bookkeeping entries.
- **No tools** additionally hides tool results.
- **User** shows only user messages.
- **Assistant** shows only assistant messages.
- **Labeled** shows checkpoints carrying Pi session labels.
- **All** includes model, thinking, custom, label, and session-title entries.

The toolbar exposes every view directly and cycles through Default → No tools → User → Assistant → Labeled → All. While the search field is focused, Pi's `Ctrl+D`, `Ctrl+T`, `Ctrl+U`, `Ctrl+L`, and `Ctrl+A` shortcuts select their corresponding core views; `Ctrl+O` and `Ctrl+Shift+O` cycle forward and backward, including Assistant. The footer reports the focused active-path position, projected count, and total count. Message rows use the standard lowercase `user` and `assistant` role names. Rows distinguish user, assistant, tool, context, summary, and metadata entries; active-path bullets, labels, and optional label timestamps use the same underlying `get_tree` metadata as Pi.

Search and projection changes retain one native virtual-list host. Heddlework rematerializes the active leaf—or its nearest visible active-path ancestor—and scrolls it into the viewport after a query is cleared. This avoids a stale native offset producing an apparently blank tree while keeping React reconciliation bounded.

Conversation overlays render statically: tree, nested selection, confirmation, input, and ask-user surfaces mount and replace one another without entrance, exit, or option-list slide animations.

## Selection semantics

Heddlework follows Pi core behavior:

- Selecting a user or custom message moves the leaf to that entry's parent and restores its text in the composer for editing and resubmission.
- Selecting an assistant, tool, compaction, or branch-summary entry moves the leaf to that entry and leaves the composer unchanged.
- Selecting the root user message produces an empty transcript with the original prompt in the composer.
- Continuing after navigation appends a child under the selected point, preserving the abandoned path in the same JSONL file.

When a selection abandons active entries, the picker offers Pi's branch-summary choices: no summary, default summary, or summary with custom focus instructions. Summary generation and `session_before_tree`/`session_tree` extension hooks remain owned by Pi.

## Active-branch hydration

A session file's final line is not necessarily the active leaf immediately after in-memory navigation. `PiSessionHistoryPager` therefore accepts Pi's `leafId` and walks parent links from that entry. Refreshes retain loaded pagination when the new leaf descends from the previous leaf, but replace the transcript when navigation switches ancestry. This matches the active branch in the running Pi process instead of displaying the most recently appended abandoned branch.

After the user submits on the selected branch, the new child is appended and naturally becomes the persisted tip Pi resumes later.

## `/tree` versus `/fork`

`/tree` keeps alternatives together in one session file and preserves the session ID. The transcript branch icon uses this behavior.

`/fork` remains available as Pi's separate-session operation. It creates a new session file and is only used when the user explicitly invokes `/fork`.
