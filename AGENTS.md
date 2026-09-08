# Dev installs

When rebuilding Heddlework Dev on this Mac, update `mbp2` too. Use `bun scripts/install-dev.ts --no-launch`; `~/.config/heddlework/dev-hosts.json` configures the automatic SSH deployment. Do not use `--local-only` unless explicitly requested. Check the remote deployment result rather than assuming the local install updated both Macs.

`ssh mbp2` logs in as `alexanderskula`. The remote app is `/Users/alexanderskula/Applications/Heddlework Dev.app`. Copy Bash scripts over before running them; the login shell is fish. Use the background runtime API for pairing probes, and never print pairing tokens.
