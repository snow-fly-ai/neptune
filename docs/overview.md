# Nebula: overview

> Message the coding agents on your PC (Claude Code, Codex, …) from your phone. The agent works on the task and notifies you when it's done.

**Related docs:**
- [architecture.md](architecture.md): code layout, data model, runtime flows, and the agent protocol
- [development.md](development.md): tools, versions, local setup, and how to run and test
- [releasing.md](releasing.md): CI, signing, auto-updates, and moving the repository

---

## 1. What problem it solves

Coding agents like Claude Code and Codex run in a terminal on a PC. To give one a task you have to be at that PC. Nebula lets you send the task from your phone. The agent runs on the PC with full access to your files and tools. You see live progress and get a push notification with its reply.

It is a **personal tool**, not a multi-tenant service. One person owns every account. That person can have several PCs (for example a home PC and a work laptop), each paired with the phone.

## 2. The two apps

A single codebase, built with Tauri 2, React and TypeScript, produces two apps. The platform decides which one runs (`src/lib/platform.ts`):

| App | Platform | Role |
| --- | --- | --- |
| **Phone app** | Android | Chat client. You sign in as an *operator*, pick an agent, send messages, watch progress, read replies, and check usage. |
| **Bridge** | Windows desktop | Lives in the tray. Signs in as the PC's *agent* account, picks up queued messages, runs the agent CLI headlessly, streams progress, and posts the reply. Shows a full-screen "ops console" with telemetry. |

Both talk only to **Supabase**: Postgres with row-level security, Realtime, Auth, and Edge Functions. The phone and PC never connect to each other directly.

```
 Phone (Tauri Android) ──insert "queued" message──▶ Supabase ◀──realtime + poll── Bridge (Tauri Windows)
        ▲                                             │                                │
        └────── realtime: replies, activity, presence ◀┘                                ▼
                                                                    claude -p … / codex exec … on the PC
```

## 3. Key concepts

| Term | Meaning |
| --- | --- |
| **Node** | One PC. Has a `name`, an **operator email** and an **agent email**. |
| **Operator email** | The account the phone signs in with. One operator can own several nodes. |
| **Agent email** | The account a PC's bridge signs in with. Belongs to exactly one node. |
| **Agent** | One coding CLI (`kind` = `claude`, `codex`, …) on one node. The bridge reports it as online, paused or busy, with its current activity and plan usage. |
| **Chat** | A conversation with one agent on one node. Stores the agent's own `session_id` (a Claude session or Codex thread), so the conversation resumes where it left off. |
| **Message** | Has a sender (`user`, `agent` or `system`) and a status. A user message moves through `queued → processing → done / error / cancelled`. |
| **Adapter** | The bridge code that drives one CLI: builds the command line, turns JSON events into activity lines, and reduces a run to one reply. |

Emails are only identifiers. **No email is ever sent.** Sign-in codes appear as QR codes on the PC instead. An email is either an operator or an agent, never both. Only emails that belong to a node can create an account.

## 4. How it works (background flow)

### Sending a task
1. The phone inserts a `messages` row: `sender='user'`, `status='queued'`, in a chat belonging to one agent.
2. The bridge on that node hears the insert over Realtime (and polls every 15 seconds in case it misses one). It calls `claim_next_message(agent_id)`, which atomically flips the oldest queued message for that agent to `processing`.
3. The bridge looks up the chat's `session_id` and runs the CLI in the configured workspace, passing the prompt on stdin:
   - Claude: `claude -p --output-format stream-json --verbose --permission-mode … [--resume <session>] --append-system-prompt …`
   - Codex: `codex exec --json --skip-git-repo-check --cd <workspace> <sandbox flags> [resume <thread>] -`
4. The Rust side streams each JSON line from the CLI to the webview. The adapter turns tool calls into short lines such as "Editing engine.ts" and writes them to `agents.activity`, at most one write every 1.2 seconds. The phone shows these live.
5. When the CLI finishes, the bridge inserts the reply (`sender='agent'`, with meta: cost, tokens, duration, model), saves the new `session_id` on the chat, and marks the user message `done` or `error`.
6. The phone gets the new reply over Realtime and shows a notification.

Each agent works its own queue one task at a time. Different agents, such as Claude and Codex, can run at the same time.

### Presence
Every 20 seconds the bridge upserts one `agents` row per CLI it found installed. The phone treats an agent as online if its last heartbeat was under 75 seconds ago. The bridge also rescans the PC for CLIs on every heartbeat, so a newly installed CLI comes online without a restart.

### Phone sign-in (QR, no email)
1. On the phone you enter the operator email. The `request-code` edge function creates a one-time Supabase Auth code and inserts a `login_requests` row for every node that email operates.
2. Each of those PCs sees the row over Realtime and shows it as a QR code (`nebula:login:<email>:<code>`), along with a Windows notification.
3. The phone scans the QR, or you type the digits, and calls `verifyOtp`.

### Pairing a new PC
1. On first run, or after being removed, the bridge calls `pair` → `start` and shows a QR code (`nebula:pair:<CODE>`).
2. A signed-in phone goes to menu › **Pair a PC**, scans the code, and enters a name and the PC's operator and agent emails. The phone then calls `pair` → `approve`.
3. The edge function creates the node, or updates it if that agent email already has one. It mints a sign-in code for the agent email and stores it on the pair request.
4. The PC, which has been polling `pair` → `status` with its secret, receives the code and signs itself in. Its session is saved in `~/.nebula/bridge.json`.
5. If the operator email is new, the phone is signed in to that account too.

## 5. Features

### Phone (Android)
- **Several operator accounts** (for example home and work) signed in at once, with a switcher in the menu. Accounts you aren't viewing still send notifications.
- **Chat list** across all agents and PCs, with a filter per agent. The header shows how many agents are online or paused. Agents are labelled "Claude · Work" when an account has several PCs.
- **New chat** with any agent, continue any chat, or delete a chat.
- **Live activity bar** showing what the agent is doing, plus a **Stop** button (`/stop`) and cancel for queued messages.
- **Commands:** `/new` starts a fresh agent session in this chat; `/status` shows the agent, model, PC, workspace, permissions and session.
- **Usage screen:** each agent's plan limits as its CLI last reported them (Claude's 5-hour and weekly windows, Codex's primary and secondary windows), plus task count, tokens and API-equivalent cost for today, 7 days and 30 days.
- **PCs list:** each PC with its online state and a **Remove** button. Removing a PC deletes its chats and sends that PC back to its pairing screen.
- **Pair a PC** and **sign in** by scanning a QR code with the camera, or typing the code.
- **Update banner** that downloads the newest APK from GitHub Releases.
- Markdown rendering for replies, and Android back-button navigation.

### Bridge (Windows)
- Runs in the tray, starts at login (`--minimized`), and allows only one copy at a time. Closing the window hides it.
- **Full-screen ops console:** live CPU, memory and network telemetry, backend latency, an event log, a packet or hex stream, a live chat feed, and an animated reticle that speeds up while an agent works. F11 toggles full screen.
- **Agents panel:** each agent's online, paused and executing state, its plan usage, and **Pause/Resume** and **Stop** buttons. **Pause all** and **Stop all** cover the whole PC. A paused agent stays online but leaves its queue alone.
- **Transmit** dialog posts a note to the phone. **Config** dialog sets the workspace, permission mode, Claude model, CLI paths, autostart and keep-awake, and has **Re-pair this PC**.
- Keeps the display awake while the console is on show (optional).
- **Auto-updates** from GitHub Releases, checking at launch and every 3 hours. It installs only while no task is running.
- If the bridge dies mid-task, on restart it marks the interrupted message as an error and tells the phone. It never reruns it silently.

### Permission modes (bridge config)
| Mode | Claude | Codex |
| --- | --- | --- |
| Full access (default) | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |
| Edit files only | `--permission-mode acceptEdits` | `--full-auto` |
| Read only | `--permission-mode default` (questions are denied, since nobody can answer) | `--sandbox read-only` |

## 6. Security model

- **Row-level security** gives each account access only to its own nodes:
  - The operator can read everything on their nodes, send user messages, create and delete chats, cancel queued messages, and remove nodes.
  - The agent can register and update its agents, claim and update messages, and post `agent` and `system` replies.
- **Only the phone and PC clients use the publishable key**, which is safe to ship. The service-role key exists only inside edge functions. PCs keep no service key.
- A `guard_signup` trigger on `auth.users` rejects any email that isn't in some node.
- Every operator is trusted with every node: pairing lets any signed-in operator create a node. This is deliberate for a single-owner setup, and something to revisit before sharing Nebula with anyone else.
- Pairing codes expire in 10 minutes and sign-in codes in 5. `request-code` is rate-limited and gives the same response whether or not the email exists.

## 7. Tech stack

| Layer | Technology |
| --- | --- |
| App shell | Tauri 2 (Rust), with a Windows NSIS installer and an Android APK (aarch64) |
| UI | React 19, TypeScript 5.9 (strict), Vite 8, plain CSS; Geist and Geist Mono fonts |
| Markdown | `react-markdown` + `remark-gfm` |
| QR | `qrcode` (display) and `@tauri-apps/plugin-barcode-scanner` (Android camera) |
| Tauri plugins | notification, opener, os, process; on desktop also updater, autostart, single-instance and tray |
| Native (Rust) | `tokio` (process spawning and streaming), `sysinfo` (telemetry), `windows-sys` (keep awake), `serde_json` |
| Backend | Supabase: Postgres with RLS, Realtime (`postgres_changes`), Auth (email OTP, minted server-side), Edge Functions (Deno) |
| Agents | Claude Code CLI, OpenAI Codex CLI |
| CI/CD | GitHub Actions (`.github/workflows/release.yml`); `tauri-action` builds Windows, the Tauri Android CLI builds the APK |

## 8. Visual language

- Dark "ops console" look. The background is `#04070B`.
- **Green** (`#22C55E`) marks live machine output and the agent. **Blue** (`#2563EB`) marks structure and anything the user sends.
- The logo is a green core inside broken blue rings, a still of the animated `Reticle`.
- Phone copy is short and plain. Agent replies are written to be phone-friendly: the system prompt asks for the outcome first, then short bullets.

## 9. Known limits

- The desktop bridge is built and tested for **Windows** only. The Rust code mostly builds on other desktops, but CLI detection and keep-awake are Windows-focused.
- The phone app is released for **Android** only. The code has `ios` branches, but iOS isn't built.
- Agents run with the PC user's permissions. By default they have full access and no sandbox.
- Plan usage is only as fresh as the CLI's last report.
- Updates are downloaded from **public** GitHub release URLs. A private repo breaks auto-updates (see [releasing.md](releasing.md)).
