# Heddlework for iOS

A thin native shell that hosts the built web workspace client (`dist/web`) in a `WKWebView` and connects it to a Heddlework host running on your Mac. The client is served from the app bundle under `heddlework-app://app`; only the WebSocket goes over the network.

## Build locally

```sh
bun install
bun run build:web
cd packaging/ios
xcodegen generate
open Heddlework.xcodeproj
```

The `Heddlework` scheme builds the app and runs `HeddleworkTests`. The Xcode project is generated from `project.yml` and is not committed.

## Connect

On the Mac:

```sh
HEDDLEWORK_HOST_BIND=0.0.0.0 bun run host
```

On the phone, paste the printed connect link, scan the QR code, or open a deep link of the form `heddlework://connect?url=<percent-encoded connect link>`. The shell stores the link and reopens straight into the workspace; Settings → Disconnect clears it.

## Xcode Cloud

`ci_scripts/ci_post_clone.sh` installs Bun and xcodegen, builds the web client, and generates the project before Xcode Cloud archives it. The workflow's primary repository is this repo and the project path is `packaging/ios/Heddlework.xcodeproj`.
