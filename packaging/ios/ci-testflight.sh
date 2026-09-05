#!/bin/bash
# Archives the iOS shell with an Apple Distribution certificate and uploads it to TestFlight.
# Inputs (environment):
#   APPLE_DIST_CERT_P12        base64 .p12 holding the Apple Distribution certificate and key
#   APPLE_DIST_CERT_PASSWORD   password for that .p12
#   IOS_PROFILE_BASE64         base64 iOS App Store provisioning profile for com.0xCUBE.Heddlework signed with that certificate
#   ASC_KEY_ID, ASC_ISSUER_ID  App Store Connect API key used for the upload
#   ASC_KEY_P8                 the API key, base64 or raw PEM
#   VERSION                    release tag such as v0.1.1 or v0.2.0-rc.1
#   BUILD_NUMBER               optional; defaults to the GitHub run number
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IOS="$ROOT/packaging/ios"
WORK="${RUNNER_TEMP:-/tmp}/heddlework-ios"
mkdir -p "$WORK"

version="${VERSION#v}"
marketing="${version%%-*}"
build_number="${BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-1}}"

# Signing keychain
KEYCHAIN="$WORK/signing.keychain-db"
echo "$APPLE_DIST_CERT_P12" | base64 --decode > "$WORK/dist.p12"
security create-keychain -p tmp "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p tmp "$KEYCHAIN"
security import "$WORK/dist.p12" -P "${APPLE_DIST_CERT_PASSWORD:-}" -A -t cert -f pkcs12 -k "$KEYCHAIN"
security set-key-partition-list -S apple-tool:,apple: -s -k tmp "$KEYCHAIN" >/dev/null
security list-keychain -d user -s "$KEYCHAIN" login.keychain
identity="$(security find-identity -v -p codesigning "$KEYCHAIN" | awk -F'"' '/Apple Distribution/{print $2; exit}')"
test -n "$identity" || { echo "No Apple Distribution identity in the imported .p12"; exit 1; }

# Provisioning profile
mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
PROFILE="$WORK/Heddlework_AppStore.mobileprovision"
echo "$IOS_PROFILE_BASE64" | base64 --decode > "$PROFILE"
profile_uuid="$(security cms -D -i "$PROFILE" | plutil -extract UUID raw -o - -)"
profile_name="$(security cms -D -i "$PROFILE" | plutil -extract Name raw -o - -)"
cp "$PROFILE" "$HOME/Library/MobileDevice/Provisioning Profiles/$profile_uuid.mobileprovision"

# App Store Connect API key for the upload
mkdir -p "$HOME/.private_keys"
P8="$HOME/.private_keys/AuthKey_${ASC_KEY_ID}.p8"
if printf '%s' "$ASC_KEY_P8" | grep -q 'BEGIN PRIVATE KEY'; then printf '%s\n' "$ASC_KEY_P8" > "$P8"; else echo "$ASC_KEY_P8" | base64 --decode > "$P8"; fi
chmod 600 "$P8"

cat > "$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$identity</string>
  <key>teamID</key><string>DNP7DGUB7B</string>
  <key>provisioningProfiles</key><dict>
    <key>com.0xCUBE.Heddlework</key><string>$profile_name</string>
  </dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
EOF

cd "$IOS"
xcodebuild archive \
  -project Heddlework.xcodeproj \
  -scheme Heddlework \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$WORK/Heddlework.xcarchive" \
  MARKETING_VERSION="$marketing" \
  CURRENT_PROJECT_VERSION="$build_number" \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM=DNP7DGUB7B \
  CODE_SIGN_IDENTITY="$identity" \
  PROVISIONING_PROFILE_SPECIFIER="$profile_name" \
  -quiet

# destination=upload sends the build to App Store Connect, which makes it a TestFlight build.
xcodebuild -exportArchive \
  -archivePath "$WORK/Heddlework.xcarchive" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -exportPath "$WORK/export" \
  -authenticationKeyPath "$P8" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  | grep -vE '^\s*$' | tail -30

echo "Uploaded Heddlework $marketing ($build_number) to TestFlight"
