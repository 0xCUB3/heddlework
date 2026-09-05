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

If the Mac is on Tailscale the printed link and QR code use the tailnet address, so the phone can connect from anywhere; otherwise they use the LAN address. On the phone, paste the printed connect link, scan the QR code, or open a deep link of the form `heddlework://connect?url=<percent-encoded connect link>`. The shell stores the link and reopens straight into the workspace; Settings → Disconnect clears it.

## TestFlight from GitHub releases

Publishing a GitHub release runs the `ios` job in `.github/workflows/release.yml`, which builds the web client, generates the project, and calls `ci-testflight.sh` to archive with manual signing and upload to App Store Connect. The build then appears in TestFlight once Apple finishes processing. The job needs these repository secrets and skips with a notice when any is missing: `APPLE_DIST_CERT_P12` and `APPLE_DIST_CERT_PASSWORD` (an Apple Distribution certificate as base64 `.p12`), `IOS_PROFILE_BASE64` (an iOS App Store provisioning profile for `com.0xCUBE.Heddlework` that lists that certificate), and `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (an App Store Connect API key with the App Manager role). The marketing version comes from the release tag and the build number from the workflow run number.

`ci_scripts/ci_post_clone.sh` remains for Xcode Cloud, which is optional.
