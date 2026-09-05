# Heddlework for iOS

A native SwiftUI workbench that connects to a Heddlework host on your Mac over URLSession WebSockets. Layout, palette, and settings follow `src/workbench/ui-contract.json`. The workspace path does not use `WKWebView`.

## Build locally

Install [XcodeGen](https://github.com/yonaskolb/XcodeGen), then:

```sh
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

If the Mac is on Tailscale, the printed link and QR code use the tailnet address so the phone can connect from anywhere. Otherwise they use the LAN address. On the phone, paste the connect link, scan the QR code, or open `heddlework://connect?url=<percent-encoded connect link>`. The app stores the link and reopens into the workspace. Settings → Disconnect clears it.

## TestFlight via Xcode Cloud

Xcode Cloud is the distribution path. After a push to the connected GitHub branch, Cloud runs `ci_scripts/ci_post_clone.sh` to generate the Xcode project, archives the `Heddlework` scheme, and uploads to App Store Connect. The bundle id is `com.0xCUBE.Heddlework`. Cloud sets `CURRENT_PROJECT_VERSION`. Signing is automatic for team `DNP7DGUB7B`.

The GitHub release `ios` job is only a fallback when Cloud is not available. It needs `APPLE_DIST_CERT_P12`, `APPLE_DIST_CERT_PASSWORD`, `IOS_PROFILE_BASE64`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_KEY_P8`.
