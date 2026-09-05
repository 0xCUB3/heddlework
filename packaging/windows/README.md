# Windows distribution

The release workflow compiles `heddlework.exe` with `bun build --compile` for `bun-windows-x64`, places the web client next to it in `web/`, and zips the pair as `heddlework-windows-x64.zip`.

When the repository has `WINDOWS_CERT_PFX` (base64 PFX) and `WINDOWS_CERT_PASSWORD` secrets, the workflow signs the executable with `signtool sign /fd sha256 /tr http://timestamp.digicert.com` before zipping. Without those secrets the asset is named `-unsigned` and SmartScreen will warn on first launch; choose More info, then Run anyway.

Package managers: `scoop bucket add heddlework https://github.com/0xCUB3/scoop-heddlework && scoop install heddlework`, or `winget install 0xCUB3.Heddlework` after the first winget-pkgs manifest is merged. The release workflow renders `heddlework.json.tmpl` into the Scoop bucket and updates winget with Komac on each stable release.

To run the zip directly:

1. Extract the zip anywhere.
2. Set `HEDDLEWORK_PI` to the path of the Pi CLI if it is not on `PATH`.
3. Launch `heddlework.exe`, optionally with a repository path as the first argument.

Heddlework checks GitHub Releases at startup and every four minutes, downloads the new zip in the background, and offers Restart to update in Settings. Because a running exe cannot be overwritten, the app writes a small `apply-update.cmd` that waits for the process to exit, swaps `heddlework.exe` and `web/`, and relaunches. Scoop and winget installs show the upgrade command instead. Set `HEDDLEWORK_UPDATE_CHECK=0` to disable the updater.
