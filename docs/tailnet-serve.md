# Tailnet HTTPS

Settings → Remote access can ask **Tailscale Serve** to proxy the local workbench to a private HTTPS name on your tailnet, for example `https://your-mac.your-tailnet.ts.net` or `https://your-mac.your-tailnet.ts.net:8443`. Phone QR and copy-link use that address when it is actually ready. Web and iOS settings cannot turn Serve on or off.

This is private tailnet access. Heddlework never enables Tailscale Funnel, never resets Serve, and never renames the machine.

## What Setup does

The workbench stays on `127.0.0.1`. Serve forwards HTTPS on this computer's MagicDNS name to that loopback port. Existing Remote access modes still work. **This Mac** stays loopback on the LAN. **Tailscale & LAN** still binds every interface.

Setup uses the Tailscale CLI (`tailscale serve --bg --yes --https <port> http://127.0.0.1:<host-port>`). Stop uses `tailscale serve --https=<port> off` only when the live handler still matches the endpoint Heddlework created.

## Ports

Serve HTTPS is tried in this order, unless you pick a free port in Settings.

| Port | URL |
| --- | --- |
| 443 | `https://<magicdns>/` |
| 8443 | `https://<magicdns>:8443/` |
| 10000 | `https://<magicdns>:10000/` |

If 443 already serves something else, Heddlework leaves it alone and uses 8443 or 10000. The UI shows the real URL, including the port. If every supported HTTPS port is taken, Setup refuses. There is no custom hostname field.

## Ready means verified

Status is **ready** only after all of these hold.

The Tailscale daemon is running and signed in.
This node has the `https` capability and a certificate domain.
Serve JSON contains Heddlework's handler on `/` for that host and port, proxying `http://127.0.0.1:<host-port>`, with Funnel off.
`https://<magicdns>[:port]/health` succeeds with default certificate verification.
`/ws` without a token returns 401 or 426, so the proxy reached the workbench.

A certificate error is not treated as success. If HTTPS certificates are not issued yet, Settings says so and can open the Tailscale admin DNS page. Apple or Tailscale may still require an approval click. Heddlework does not fake that step.

## Ownership

The chosen port, MagicDNS name, and proxy target are stored in `preferences.json` as `tailscaleServe`. Theme, remote access, and sleep policy in that file are left intact.

Stop removes the endpoint only when Serve still has that exact handler. If you changed it in the Tailscale app, Heddlework leaves it alone and drops its own claim.

Heddlework does not run `tailscale serve reset`, does not edit ACLs, and does not log in or out.

## Clients

The connect link still carries the host token as `?token=`. iOS already accepts `https://` and `wss://`. The web client maps `https` to `wss`. The welcome `hostUrls` list puts the tailnet HTTPS origin first when ready so a client can rotate to it.

Scan the QR from a phone that is on the same tailnet, with Tailscale running. MagicDNS must resolve on that phone. If MagicDNS is off, the name still works only where that tailnet DNS is configured.

## Headless host

`bun run host` reads the same `tailscaleServe` preference. If Setup was used in the desktop app, the headless process brings the endpoint back and prints the tailnet link. It will not invent Serve config on a machine that never enabled it.
