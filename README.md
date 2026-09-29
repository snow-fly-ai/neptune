# Nebula

Message the coding agents on your PC (Claude Code, Codex, …) from your phone. The agent works on the task and notifies you when it's done.

- **Phone (Android):** chat with any agent on any of your PCs. Watch live progress, get a notification when the reply lands, and check each agent's plan usage.
- **Desktop (Windows):** a tray bridge with a full-screen ops console. It picks up your messages, runs the agent CLI headlessly on the PC, and posts the answer back.
- **Backend:** Supabase (Postgres with row-level security, Realtime, Auth, Edge Functions). Each PC is a *node* with its own operator and agent email pair. Sign-in and pairing use QR codes; nothing is emailed.

```
 phone (Tauri Android) ──queued message──▶ Supabase ◀──realtime/poll── desktop bridge (Tauri Windows)
        ▲                                     │                              │
        └──── replies, activity, presence ◀───┘                              ▼
                                                             claude -p / codex exec on the PC
```

## Quick start

```bash
npm ci
```

Browser preview at http://localhost:1420. Add `?mode=bridge` or `?mode=phone`:

```bash
npm run dev
```

Desktop bridge (read docs/development.md first):

```bash
npx tauri dev
```

## Using it

1. Install the Windows app on a PC. On first run it shows a pairing QR code.
2. Install the Android app and sign in with your operator email. A paired PC shows a QR code; scan it, or type the digits under it.
3. On the phone, open the menu › **Pair a PC**, scan the new PC's code, and choose its name and email pair.
4. Start a chat with an agent and send a task. `/new` starts a fresh session in that chat, `/status` shows the agent's setup, and the Stop button cancels a running task.

The PC's agent CLIs must be signed in once: `claude auth login` for Claude Code, `codex login` for Codex.

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/overview.md](docs/overview.md) | What Nebula is, how it works, features, security model, tech stack |
| [docs/architecture.md](docs/architecture.md) | Code layout, bridge engine, Tauri commands, database and RLS, edge functions, protocols |
| [docs/development.md](docs/development.md) | Required tools and versions, configuration, running locally, Supabase workflow, conventions |
| [docs/releasing.md](docs/releasing.md) | CI releases, signing secrets, auto-updates, moving the repository |
| [AGENTS.md](AGENTS.md) | Instructions for AI coding agents |
