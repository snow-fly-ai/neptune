# Nebula

Message the coding agents on your PC (Claude Code, Codex, …) from your phone. The agent works on the task and pings you when it's done.

- **Phone (Android):** chat client. Sign in with your operator email, then scan the QR code your PC shows. Stay signed in to several operator accounts (say home and work) and switch between them in the menu; the others still notify. A chat list shows every conversation with every agent (filter by agent); open any chat to continue it, or start a new one with any agent. Watch live progress and get a notification when a reply lands. **Usage** (menu) shows each agent's plan limits (Claude's 5-hour and weekly windows, Codex's primary/secondary) as its CLI last reported them, plus tasks, tokens and API-equivalent cost for today / 7 / 30 days.
- **Desktop (Windows):** the bridge, shown as a full-screen ops console: live CPU, memory and network telemetry (from the native `sys_stats` command), an event log, a packet stream, and a central animated reticle that speeds up while Claude works. It keeps the display awake (`keep_awake`). The **Agents** panel lists every agent with what the phone sees (online, paused, executing), its plan usage, and **Pause/Resume** and **Stop** buttons; **Pause all / Stop all** in the top bar cover the whole bridge. A paused agent stays online but leaves its queue alone until resumed (kept in `pausedAgents` in the bridge config). Sending a note to the phone and the bridge settings are in the Transmit and Config dialogs. F11 toggles full screen.
- **Theme:** green (#22C55E) marks live machine output and the agent. Blue (#2563EB) marks structure and anything you send.
- **Desktop bridge internals:** It lives in the tray, picks up queued messages for every agent it finds installed, runs them headlessly (`claude -p --output-format stream-json`, `codex exec --json`), streams "what I'm doing now" to the phone, and posts the final answer back. Each agent works its own queue, so Claude and Codex can run at the same time.
- **Backend:** Supabase (Postgres, realtime, auth, edge functions). Row-level security scopes every row to one PC (node): its operator reads and sends, its agent runs the queue. The PCs hold no service key.

Both apps are the same Tauri 2 + React codebase. The platform decides the mode (`android` → phone, desktop → bridge).

```
 phone (Tauri Android) ──insert "queued" msg──▶ Supabase ◀──realtime/poll── desktop bridge (Tauri Windows)
        ▲                                         │                               │
        └──── realtime: replies, activity ◀───────┘                               ▼
                                                                    claude -p / codex exec on the PC
```

## PCs, emails and pairing

Each PC is a **node** with its own email pair:

- **Operator email**: the phone signs in with it. One operator can own several PCs.
- **Agent email**: that PC's bridge signs in with it.

Emails are only IDs; nothing is mailed. An email is an operator or an agent, never both. Only emails that belong to a node can create an account (`guard_signup`), and every operator is trusted with every node: this is one person's set of accounts.

**Adding a PC:** install Nebula on it. On first run it shows a pairing QR (`supabase/functions/pair`). On the phone, menu › **Pair a PC**, scan it, and pick the PC's name and emails. The PC signs itself in as its agent email and keeps the session in `bridge.json`. A new operator email is signed in on the phone as another account. **PCs** in the menu lists them; **Remove** deletes a PC with its chats, and that PC goes back to its pairing screen. Config › **Re-pair this PC** does the same from the PC.

**Signing in the phone:** enter the operator email; every PC it operates shows a QR code (`supabase/functions/request-code` → `login_requests`). Scan it, or type the digits under it.

## Agents and chats

- `nodes`: one row per PC: `name`, `operator_email`, `agent_email`, `machine`.
- `agents`: one row per agent `kind` (`claude`, `codex`, …) per node, with presence (`online`, `last_seen`), `paused`, `activity`, `current_chat_id` and `usage` (latest plan-limit snapshot).
- `chats`: belongs to one agent; `session_id` is the agent's own conversation id (Claude session, Codex thread), so every chat resumes where it left off.
- `messages`: every message has a `chat_id`. `sender` is `user`, `agent` or `system`.

Adapters live in `src/bridge/agents.ts`. The Rust side (`run_agent`) just runs a CLI and streams its JSON lines; each adapter builds the command line and turns events into activity lines and one reply.

### Plugging in another agent

Either add an adapter to `ADAPTERS` in `src/bridge/agents.ts`, or run any separate process signed in as a node's agent email that follows this protocol:

1. **Heartbeat** every ~20s: `upsert` into `agents` `{ node_id, kind, name, online: true, last_seen: now(), machine, version }` on conflict `node_id,kind`, keeping the returned `id`. The phone shows it online within 75s of the last heartbeat. On exit set `online: false`.
2. **Claim** work: `rpc('claim_next_message', { p_agent: '<agent id>' })` atomically flips the oldest queued user message in that agent's chats to `processing` and returns it (or nothing).
3. **Context**: read `chats.session_id` for `message.chat_id`; resume that conversation, and write back the new id when it changes.
4. **Progress**: update `agents.activity` (one short line) and `current_chat_id` while working; clear both when done.
5. **Reply**: insert `{ chat_id, sender: 'agent', body, status: 'sent', reply_to: message.id, meta: { agent: '<id>', duration_ms } }`, then set the user message's `status` to `done` or `error`.
6. **Commands**: `/stop` (cancel the running task in that chat; realtime insert), `/new` (clear `chats.session_id`), `/status`.

## Phone commands

| Send | Effect |
| --- | --- |
| `/new` | Start a fresh agent session in this chat (forget context) |
| `/status` | Agent, bridge machine, workspace, permissions, session |
| Stop button | Cancels the running task (`/stop`) |

## Releases & updates

Push a tag `vX.Y.Z` and GitHub Actions builds:

- `Nebula_X.Y.Z_x64-setup.exe` + `latest.json`. The desktop bridge auto-updates from these via `tauri-plugin-updater`.
- `Nebula_X.Y.Z_android.apk`, signed with a fixed keystore so it installs over the previous version. The phone app shows an "update available" banner that downloads it.

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

## Renamed from Relay

Until v0.3.0 the app was called Relay (`com.snowfly.relay`). From v0.4.0 it's Nebula (`com.snowfly.nebula`):

- **Desktop:** Relay's auto-updater installs Nebula. On first run Nebula copies `~/.relay/bridge.json` to `~/.nebula/bridge.json`, removes Relay's autostart entry and runs Relay's uninstaller.
- **Android:** the package name changed, so Nebula installs next to Relay. Sign in once, then uninstall Relay.

## Bridge config

`~/.nebula/bridge.json` (never committed; kept outside AppData so MSIX-packaged tools see the same file):

```json
{ "auth": { "nebula-bridge": "<session, written by the app>" }, "workspace": "C:\\Users\\you", "permissionMode": "bypassPermissions", "claudePath": "", "model": "", "codexPath": "", "codexModel": "" }
```

Bridges up to 0.4 kept the Supabase service key here as `serviceKey`. On upgrade the bridge uses it once to sign in as its node's agent email, then deletes it. `NEBULA_CONFIG_DIR` points the bridge at another folder, so a second bridge (built with another app identifier) can run on one PC for testing.

`claudePath` is auto-detected: `~/.local/bin/claude.exe`, then `PATH`, then the copy bundled with the Claude desktop app. The CLI must be signed in once with `claude auth login`.

`codexPath` is auto-detected: `codex.exe` on `PATH`, then the native binary inside the global npm package (`npm i -g @openai/codex`), then `codex.cmd`. Sign in once with `codex login`. The bridge rescans every heartbeat, so a newly installed Codex comes online without a restart. Permission modes map to Codex as: full access → `--dangerously-bypass-approvals-and-sandbox`, edit files → `--full-auto`, read only → `--sandbox read-only`.

## Development

```bash
npm install
npm run dev            # web preview; add ?mode=phone or ?mode=bridge
npx tauri dev          # desktop bridge
```
