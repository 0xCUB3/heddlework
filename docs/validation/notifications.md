# Notifications

Copy, settle, and other local confirmations are toasts. They stay on the originating client and never enter the remote snapshot.

The ledger keeps completions, failures, and input requests. Rows open the owning session. Retention is 50 ledger events, deduped by `eventId`.

OS alerts fire only for an away client chosen from live presence. A focused or visible client is treated as here. Reconnect does not replay alerts. Background push while the Mac is offline needs a hosted APNs/Web Push relay, which is not configured.

Checked 2026-09-06: `bun test` 519 pass, `bun run typecheck` and `typecheck:web` clean, iOS `NotificationTests` `UIContractTests` `WorkspaceProtocolTests` 12 pass on simulator E83D7471. No live Tailscale tab or TestFlight run. No APNs relay.
