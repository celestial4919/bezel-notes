# Bezel Notes updater — ready-to-wire release setup

The Tauri updater integration is wired into these files:

- `package.json` — updater JS plugin dependency
- `src-tauri/Cargo.toml` — updater Rust plugin
- `src-tauri/lib.rs` — updater plugin registration
- `src-tauri/capabilities.json` — `updater:default` permission
- `src-tauri/tauri.conf.json` — public key, signed updater artifacts, passive Windows install mode, and release endpoint placeholder
- `src/routes/+page.svelte` — quiet, on-demand update check when the panel is summoned

## One value still needs replacing

In `src-tauri/tauri.conf.json`, replace:

`https://github.com/YOUR-GITHUB-USERNAME/YOUR-REPO/releases/latest/download/latest.json`

with the actual GitHub Releases `latest.json` URL for Bezel Notes.

## Keep the private key private

Never commit `bezel-notes.key` to GitHub and never send it in chat. Keep the private key on the release machine, or later move it into a GitHub Actions secret.

For a local PowerShell release build, set the signing key before `npm run tauri build` using your real private-key path/content, for example:

`$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\Users\YOURNAME\.tauri\bezel-notes.key'`

Then run the normal signed Tauri build.

## Behavior

Bezel Notes does not check for updates during startup. The first time the user summons the panel, it performs one background update check for that app session. If an update exists, a small `Update <version>` control appears above the branding footer. Installation is user-triggered; there is no forced update.
