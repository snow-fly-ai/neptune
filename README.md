# Relay

Message Claude on your PC from your phone. Claude works on the task and pings you when it's done.

- **Phone (Android):** chat client. Sign in with your email (6-digit code), send tasks, watch live progress, get a notification when a reply lands.
- **Desktop (Windows):** the bridge, shown as a full-screen ops console: live CPU, memory and network telemetry (from the native `sys_stats` command), an event log, a packet stream, and a central animated reticle that speeds up while Claude works. It keeps the display awake (`keep_awake`). Sending a note to the phone and the bridge settings are in the Transmit and Config dialogs. F11 toggles full screen.
- **Theme:** green (#22C55E) marks live machine output and the agent. Blue (#2563EB) marks structure and anything you send.
- **Desktop bridge internals:** It lives in the tray, picks up queued messages, runs them through the Claude Code CLI headlessly (`claude -p --output-format stream-json`), streams "what I'm doing now" to the phone, and posts the final answer back.
- **Backend:** Supabase (Postgres, realtime and auth). Row-level security only lets the allow-listed owner email read or send messages.

Both apps are the same Tauri 2 + React codebase. The platform decides the mode (`android` → phone, desktop → bridge).

```
 phone (Tauri Android) ──insert "queued" msg──▶ Supabase ◀──realtime/poll── desktop bridge (Tauri Windows)
        ▲                                         │                               │
        └──── realtime: replies, activity ◀───────┘                               ▼
                                                                    claude -p (Claude Code CLI) on the PC
```

## Phone commands

| Send | Effect |
| --- | --- |
| `/new` | Start a fresh Claude session (forget context) |
| `/status` | Bridge machine, workspace, permissions, session |
| Stop button | Cancels the running task (`/stop`) |

## Releases & updates

Push a tag `vX.Y.Z` and GitHub Actions builds:

- `Relay_X.Y.Z_x64-setup.exe` + `latest.json`. The desktop bridge auto-updates from these via `tauri-plugin-updater`.
- `Relay_X.Y.Z_android.apk`, signed with a fixed keystore so it installs over the previous version. The phone app shows an "update available" banner that downloads it.

```bash
node scripts/bump.mjs 0.2.0
git commit -am "Release 0.2.0"
git tag v0.2.0
git push --follow-tags
```

### Required repo secrets

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Signs desktop updates |
| `ANDROID_KEY_BASE64` / `ANDROID_KEY_PASSWORD` / `ANDROID_KEY_ALIAS` | Signs the APK |

## Bridge config

`~/.relay/bridge.json` (never committed; kept outside AppData so MSIX-packaged tools see the same file):

```json
{ "serviceKey": "…", "workspace": "C:\\Users\\you", "permissionMode": "bypassPermissions", "claudePath": "", "sessionId": "", "model": "" }
```

`claudePath` is auto-detected: `~/.local/bin/claude.exe`, then `PATH`, then the copy bundled with the Claude desktop app. The CLI must be signed in once with `claude auth login`.

## Development

```bash
npm install
npm run dev            # web preview; add ?mode=phone or ?mode=bridge
npx tauri dev          # desktop bridge
```
