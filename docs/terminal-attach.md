# Heddlework terminal attach client

`bun run pi:attach` opens an explicit terminal frontend for a Pi process that Heddlework has already discovered through its live bridge. It attaches to the same running process used by the app; it does not spawn Pi and does not write the session JSONL.

Use `bun run pi:attach -- --list` to list attachable sessions, or `bun run pi:attach -- --session /absolute/or/relative/session.jsonl` to select one. Paths are normalized before matching. If selection is ambiguous, the requested session is unavailable, or no live bridge exists, the client exits with an error instead of guessing.

The client labels itself `Heddlework terminal attach client`, displays only a bounded tail of initial history (both message-count and text-size bounded), and then follows live user, assistant, and tool events. Streaming assistant tokens are coalesced into sensible chunks at a bounded refresh cadence so terminal rendering does not become token-rate work. Control sequences from model/tool/session text are stripped before display. When interactive readline is available, incoming output redraws the current prompt so partially typed input is retained. If the live owner disconnects, the attach client exits its prompt instead of leaving a dead shell.

Local commands are `/abort`, `/name <name>`, `/thinking <level>`, `/help`, and `/detach`. Any other line is sent as a prompt through the existing authenticated live bridge. Detaching closes only this frontend connection; it does not terminate the Pi process.

This is intentionally not the stock Pi TUI. It is a small Heddlework frontend for bidirectional access to the same app-owned/live-attached session while upstream Pi has no supported second-TUI attachment mode.
