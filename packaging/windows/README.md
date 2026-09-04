# Windows distribution

The release workflow compiles `heddlework.exe` with `bun build --compile` for `bun-windows-x64`, places the web client next to it in `web/`, and zips the pair as `heddlework-windows-x64.zip`.

When the repository has `WINDOWS_CERT_PFX` (base64 PFX) and `WINDOWS_CERT_PASSWORD` secrets, the workflow signs the executable with `signtool sign /fd sha256 /tr http://timestamp.digicert.com` before zipping. Without those secrets the asset is named `-unsigned` and SmartScreen will warn on first launch; choose More info, then Run anyway.

To run:

1. Extract the zip anywhere.
2. Set `HEDDLEWORK_PI` to the path of the Pi CLI if it is not on `PATH`.
3. Launch `heddlework.exe`, optionally with a repository path as the first argument.

Heddlework checks GitHub Releases once at startup and posts a notice with the download link when a newer version exists. Set `HEDDLEWORK_UPDATE_CHECK=0` to disable the check.
