# Browser integrations

Settings → Browser offers the built-in GPUix browser, Aside, and custom host adapters. Web and native SwiftUI clients use the connected host. They do not open a browser on the phone.

## Aside

1. Install Aside and its CLI on the host. Start Aside and sign in there.
2. Run `aside account` on the host to find your account ID, such as `u0`.
3. In Settings → Browser, choose Aside, enter that ID, and save.
4. Describe a task. Select **Review task**, check the exact account and request, then **Approve and run**.
5. Read the output there. **Copy result to chat draft** lets you inspect it before sending it to Pi.

Aside uses the chosen account’s logged-in browser. This is account-level access, not a tab sandbox. Heddlework does not copy cookies, read browser databases, list tabs on startup, or start tasks just because an adapter is selected. CLI detection does not prove Aside is running or signed in; launch errors appear in the task output.

The built-in browser still uses its existing isolated profiles and desktop panes. Selecting it disables external task execution. It does not import your system browser’s cookies.

## Bring your own adapter

Create `integrations.json` in Heddlework’s browser data directory. On macOS this is `~/Library/Application Support/Heddlework/Browser`. Linux uses `$XDG_DATA_HOME/heddlework/browser` (or `~/.local/share/heddlework/browser`). Windows uses `%LOCALAPPDATA%/Heddlework/Browser`.

```json
{
  "version": 1,
  "adapters": [{
    "id": "my-browser",
    "label": "My browser",
    "command": "/absolute/path/to/my-browser-adapter",
    "args": [],
    "description": "Uses the profile selected below. Explain its account scope here."
  }]
}
```

Restart the host to load it. `HEDDLEWORK_BROWSER_ADAPTERS` can point to another host-owned config file. Remote clients cannot install executables or change this path. Invalid config leaves the built-in browser and Aside available and reports the error.

The executable receives one JSON line on stdin:

```json
{"version":1,"profile":"work","prompt":"Read the latest release notes"}
```

Write human-readable output to stdout; use stderr for diagnostics. Exit zero on success. Output is plain text, never evaluated as code. Heddlework runs an argument array without a shell, caps output at 128 KiB, and limits each local wait to five minutes. Arguments come only from host config, not remote requests.

Adapters are trusted local programs, not sandboxed plugins. They inherit the host environment. Keep secrets out of config arguments and output. Profile isolation and browser permissions are the adapter’s responsibility. TypeScript embedders can implement `BrowserTaskAdapter` and construct `BrowserIntegrationService`; both are exported from `src/plugin-api.ts`.

## Approval and privacy

Every task needs a fresh, one-use approval bound to its exact prompt, adapter, and profile. Reviews expire after five minutes. Changing the selection discards pending approval. Grants and output are not saved by Heddlework; only the chosen adapter and profile persist. Aside may retain its own sessions under its own settings.

Explicitly describe any send, purchase, deletion, or account change before approving. Heddlework confirms the whole task, not every browser click. Aside receives a scope instruction, but that is not a security sandbox. Aside’s `guard` mode controls its file access; it does not provide a per-action web safety guarantee. Use a separate browser account when you need stricter isolation.

All authenticated clients connected to this host can review tasks and see their output. Treat the host token as account access. Use trusted devices and Tailscale or TLS for remote connections. Disconnecting one client does not stop a host task.

**Stop local connection** ends the local adapter process. A remote agent may still be running. The UI reports this as `detached`, not `cancelled`; open Aside or your adapter to stop that work. Timeouts and host shutdown have the same limitation. Clearing output removes it from Heddlework’s current in-memory task, not from the browser provider’s history.
