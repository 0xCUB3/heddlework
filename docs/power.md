# Host sleep prevention

Settings → Power controls idle sleep on the **host computer** running Heddlework or `bun run host`. A phone or browser never changes its own sleep this way.

## Policy

The choice is stored in `preferences.json` as `sleepPrevention`.

| When | Effect |
| --- | --- |
| `off` | No inhibitor. The machine may idle-sleep during agent work. |
| `whileWorking` (default) | Inhibit only while an agent turn, live tool, compaction, queue dispatch, or approved browser task is actually running. Queued rows, paused flows, and dialogs do not count. |
| `whileAppOpen` | Inhibit until this desktop app or headless host process exits. |

`keepDisplayAwake` also blocks display sleep on macOS (`caffeinate -d`) and Windows (`ES_DISPLAY_REQUIRED`). Linux logind idle/sleep can be blocked; display blanking is compositor-owned and is **not** claimed.

New installs default to `whileWorking` with the display still allowed to sleep.

## Backends

| Platform | Mechanism | Display |
| --- | --- | --- |
| macOS | Owned `/usr/bin/caffeinate -i` (`-d` when the display option is on), with `-w` on the Heddlework pid so the child exits if the app dies | Yes |
| Windows | `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` on the surviving main thread | Yes |
| Linux | Owned `/usr/bin/systemd-inhibit --what=sleep:idle --mode=block /bin/cat` with stdin held; missing logind or binary is `unsupported` or `error` | No |

Heddlework does not change power schemes, does not use sudo, and does not leave an inhibitor after dispose, abort, or process exit.

## Limits

Idle-sleep prevention is not a sleep lock. Choosing **Sleep**, closing a lid, running out of battery, or an OS policy that ignores user-idle assertions can still sleep the machine. Settings shows the live status (`idle`, `active`, `unsupported`, `error`) and will not claim the machine is protected after a backend failure.

Remote clients send `setSleepPreventionPolicy` over the authenticated host protocol. The host applies it; the phone does not.
