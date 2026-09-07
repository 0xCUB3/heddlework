# Pi TUI live sync

Heddlework can attach to a Pi process that is already running in the TUI without starting a second writer for the same session JSONL.

Starting a non-demo Heddlework workspace runtime installs `heddlework-live-bridge.js` in Pi's user extension directory (`~/.pi/agent/extensions` by default, or `PI_CODING_AGENT_DIR/extensions`). New ordinary `pi` TUI launches load it automatically. For a TUI that was already running, use Pi's `/reload` or restart it **before opening its session in Heddlework**. A process that has not loaded the bridge cannot advertise its ownership; reading its JSONL is not live synchronization. Heddlework-owned RPC launches also load a private materialized copy explicitly.

Each live Pi process owns its session and opens a loopback-only TCP listener on an ephemeral port. It writes a per-process advertisement beneath Heddlework's stable per-user runtime/state directory (or `HEDDLEWORK_RUNTIME_DIR`). Advertisements are created private (`0600`), and each process generates a random 256-bit bearer token. The bridge never binds a LAN interface.

`discoverPiLiveBridges()` removes advertisements only after the owning process is gone; a legitimate long-running Pi is never expired by file age. `createPiTransport()` defers selection until `start()`, and attaches only on an explicit session file or session ID match—cwd alone never claims a running TUI. Once attached, it never falls back to spawning another writer after disconnect. `AgentTransport.ownership` exposes `attached` versus `owned` after selection for bootstrap/reconnect safety. `PiLiveBridgeTransport` authenticates with the advertised token and then uses UTF-8-safe JSONL request/response framing. It supports the controller refresh surface (`get_state`, messages, tree, fork messages, thinking levels, stats), safe prompt/steer/follow-up dispatch, abort, model, thinking level, session name, and image-bearing prompts using Pi's native text/image content array.

Attachment starts with one atomic snapshot containing session state, the current assistant/tool activity, and a sequence boundary. Optional initial history is message-count bounded. Events newer than that boundary are replayed in order, avoiding a duplicated or missing prefix when attaching mid-response. Session metadata is written only on meaningful transitions, not on every generated token. Bridge credentials stay local and are never projected into the app's shared session catalog.

When the TUI changes sessions, Heddlework follows the owner's new session identity and pauses existing queued work for review rather than sending it into the wrong conversation. Closing the attached app/terminal frontend does not stop a TUI-owned Pi process. On normal owner shutdown the bridge closes clients and removes its advertisement; discovery cleans stale entries after crashes.

For the reverse direction—working in a terminal on an app-owned session—use the [Heddlework terminal attach client](terminal-attach.md):

```sh
bun run pi:attach -- --list
bun run pi:attach -- --session /absolute/path/to/session.jsonl
```

This terminal frontend talks to the existing process; it does not launch another Pi writer. It is not the stock Pi TUI. The locally validated Pi 0.85.1 installation does not expose a supported second-TUI remote attachment mode. Do not launch another `pi --session` against an app-owned session as a substitute. Interactive-only extension dialogs and unsupported owner commands remain in the original TUI; the bridge returns an error rather than pretending those operations succeeded.
