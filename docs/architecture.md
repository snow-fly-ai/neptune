# Nebula: architecture

How the code is organized, how the parts talk to each other, and where to make changes. For what the product does, see [overview.md](overview.md). For running it, see [development.md](development.md).

---

## 1. System shape

```
┌──────────────── one codebase (Tauri 2 + React) ────────────────┐
│                                                                  │
│  src/main.tsx ── getMode() ──┬── 'phone'  → src/phone/PhoneApp   │  Android build
│                              └── 'bridge' → src/bridge/BridgeApp │  Windows build
│                                                                  │
│  src-tauri/ (Rust): plugins, tray, bridge commands, telemetry    │
└──────────────────────────────────────────────────────────────────┘
                 │  supabase-js (publishable key + user session)
                 ▼
┌────────────────────────── Supabase ──────────────────────────────┐
│  Postgres + RLS: nodes, agents, chats, messages,                  │
│                  login_requests, pair_requests                    │
│  Realtime: postgres_changes on the tables above                   │
│  Auth: email OTP (codes minted server-side, never emailed)        │
│  Edge Functions (Deno): request-code, pair (use the service role)│
└───────────────────────────────────────────────────────────────────┘
```

- **The mode is chosen at runtime.** `src/lib/platform.ts` returns `?mode=phone|bridge` if present in the URL. Otherwise it returns `phone` outside Tauri and on Android/iOS, and `bridge` on desktop. `main.tsx` sets `data-mode` on `<html>` and renders the matching root.
- **The Rust side is intentionally thin.** It runs processes and reads the machine. All product logic (queue, adapters, auth, UI) is in TypeScript.
- **No server of our own.** Clients call Postgres directly, protected by RLS. Only operations that need the service role (minting sign-in codes, creating nodes) go through edge functions.

## 2. Repository layout

```
.
├── AGENTS.md / CLAUDE.md        Instructions for AI agents (CLAUDE.md just includes AGENTS.md)
├── README.md                    Short intro plus links into docs/
├── docs/                        overview, architecture (this file), development, releasing
├── index.html                   Vite entry HTML (dark theme-color, mounts #root)
├── package.json                 JS deps and scripts (dev, build, tauri); version is kept in sync by scripts/bump.mjs
├── vite.config.ts               Dev server on port 1420 (strict), ignores src-tauri, target es2021
├── tsconfig.json                Strict TS, noUnusedLocals/Parameters, bundler resolution, src/ only
├── app-icon.svg                 Source for `tauri icon` (generates src-tauri/icons/**)
├── public/icon.svg              Favicon for the web preview
├── android/MainActivity.kt      Replaces the generated Android activity in CI (edge-to-edge insets, dark background)
├── scripts/
│   ├── bump.mjs                 `node scripts/bump.mjs X.Y.Z` → package.json, tauri.conf.json, Cargo.toml
│   └── prepare-android.mjs      CI: copies MainActivity and icons into the generated project, patches release signing into Gradle
├── .github/workflows/release.yml  Tag v* → Windows installer, updater JSON, Android APK, publish release
├── src/                         All TypeScript/React (see §3)
├── src-tauri/                   Rust crate, Tauri config, capabilities, icons (see §4)
└── supabase/
    ├── migrations/              SQL, applied in filename order (see §5)
    └── functions/               Edge functions: request-code, pair (see §6)
```

Git-ignored and generated: `node_modules/`, `dist/` (Vite output), `src-tauri/target/`, `src-tauri/gen/` (Tauri-generated schemas and Android project), keystores and `.env*`.

## 3. Frontend: `src/`

```
src/
├── main.tsx              Picks PhoneApp or BridgeApp; loads fonts and styles.css
├── styles.css            Global theme tokens (--green, --blue, --font, --mono…) and all phone UI styles
├── lib/                  Shared by both apps
│   ├── config.ts         SUPABASE_URL, SUPABASE_KEY (publishable), GITHUB_REPO, ONLINE_WINDOW_MS, QR payload format and parser
│   ├── types.ts          Row types: Node, Agent, Chat, Message, MessageMeta, AgentUsage, UsageWindow
│   ├── platform.ts       getMode(), inTauri()
│   ├── useConversation.ts  Realtime hooks: useConversation (messages), useChats (chats, agents, nodes), useNow, isOnline, agentLabel
│   ├── fn.ts             callFn(): invokes an edge function and turns its { error } into a thrown Error
│   ├── notify.ts         Native notifications (permission handling, markdown stripped, length clipped)
│   ├── updates.ts        appVersion(), compareVersions(), checkPhoneUpdate() (GitHub latest release → APK URL)
│   └── open.ts           Opens external URLs (Tauri opener, or window.open in the browser)
├── ui/                   Presentational components used by both apps
│   ├── MessageList.tsx   Message bubbles, day separators, per-message status and cancel
│   ├── Composer.tsx      Input box plus send
│   ├── ActivityBar.tsx   "What the agent is doing now" strip, with a Stop button
│   ├── Markdown.tsx      react-markdown + GFM, links opened externally
│   ├── Reticle.tsx       Animated brand mark (idle, busy, offline)
│   ├── icons.tsx         Inline SVG icons and <Logo>
│   └── time.ts           clock(), dayLabel(), ago(), duration()
├── phone/                Android chat client
│   ├── PhoneApp.tsx      Root: accounts, active-account context, background notifiers, Home (list ⇄ chat/usage/pair views)
│   ├── accounts.ts       Several signed-in accounts: one supabase client per email, storageKey `nebula-auth:<email>`
│   ├── client.ts         ClientContext and useClient() for the active account
│   ├── AuthScreen.tsx    Email → request-code → scan or type the QR code → verifyOtp
│   ├── PairScreen.tsx    Scan the PC's pair QR → peek → name and emails → approve (may sign in a new operator)
│   ├── ChatList.tsx      Chat list, agent filter, new chat, menu (accounts, PCs sheet, pair, usage, sign out)
│   ├── ChatScreen.tsx    One chat: messages, activity bar, composer, cancel, delete, latency
│   ├── UsageScreen.tsx   Plan-limit windows per agent, plus token and cost totals from message meta
│   └── scan.tsx          Barcode-scanner wrapper (transparent webview + overlay; cancel workaround)
└── bridge/               Windows desktop bridge
    ├── BridgeApp.tsx     Boot (config → sign in → node), Pairing screen, Console (all panels, modals, config form, updater, autostart, keep awake)
    ├── engine.ts         BridgeEngine: heartbeat, realtime inbox, queue claiming, running tasks, replies, pause/stop, login QR
    ├── agents.ts         Agent adapters (Claude, Codex): CLI arguments, event → activity, result → reply and meta, usage parsing
    ├── auth.ts           ConfigStore (serialized bridge.json writes), bridgeClient() (session saved in bridge.json), connect(), loadNode()
    ├── native.ts         Typed wrappers for Rust commands (load/save config, host_info, run_agent + agent-event stream, cancel)
    ├── telemetry.ts      useTelemetry() (sys_stats once a second; simulated in the browser), useLatency(), formatters
    ├── widgets.tsx       HUD pieces: Panel, Spark, Meter, HexStream, Typewriter, Scramble, Spinner, CountdownRing
    ├── Qr.tsx            QR code rendering (qrcode → inline SVG, dark on white)
    └── ops.css           Console-only styles
```

### Phone state and data flow
- `PhoneApp` keeps a list of account emails in `localStorage` (`nebula.accounts`, with the active one in `nebula.account`). Each account has its own `SupabaseClient` from `clientFor(email)`. The active one is provided through `ClientContext`.
- `useChats(client)` loads chats, agents and nodes, subscribes to changes on all of them, and reports every new message so `Home` can notify. `useConversation(client, chatId)` does the same for one chat's messages. Both also refresh every 30 seconds and when the app comes back to the foreground, in case a socket drops.
- For each inactive account, `BackgroundAccount` subscribes to message inserts and notifies.
- Views are `list | chat | usage | pair`. Opening one pushes a `history` entry so Android's back button returns to the list.
- Sending a message is a direct `insert` into `messages` (`sender='user'`, `status='queued'`). Creating a chat is an `insert` into `chats` with an `agent_id`; a trigger fills in `node_id`.

### Bridge state and data flow
- **Boot (`BridgeApp`):** `loadConfig()` + `hostInfo()` + `appVersion()` → `ConfigStore` → `bridgeClient(store)` → `connect()`. This retries through network errors and adopts a leftover service key if there is one. Then `loadNode()`. If there's no node, the app shows `Pairing`. If there is, it shows `Console`.
- **`BridgeEngine`** is a small external store (`subscribe` and `getSnapshot`) read with `useSyncExternalStore`. It owns one `WorkerState` per adapter.
  - `start()`: heartbeat → `recoverInterrupted` → realtime channel `bridge-inbox`. The channel receives user message inserts (`/stop` is handled right away; anything else triggers `kickAll`) and `login_requests` inserts for this node (shown as a QR). Then it sets a heartbeat timer (20 s) and a poll timer (15 s).
  - `kick(adapter)`: while the bridge is running and the agent isn't paused, `claim_next_message` → `handle()`. `handle()` deals with `/new`, `/stop` and `/status` itself and sends anything else to `runTask()`.
  - `runTask()` resolves the CLI path and loads the chat's session. It calls `adapter.run()` with three hooks: `activity` (throttled writes to `agents.activity`), `session` (saves `chats.session_id`) and `usage` (saves `agents.usage`). It then handles the outcome: cancelled, stale session (retries once with a fresh session), no result, or success (reply plus meta).
  - Heartbeat failure plus a missing node means the PC was removed on the phone. The engine stops and calls `onUnpaired`, and the UI returns to `Pairing`.
- The **auth session is stored in `bridge.json`**, not in the webview, through a custom supabase-js `storage` backed by `ConfigStore`. It survives reinstalls and webview data resets.

## 4. Native: `src-tauri/`

```
src-tauri/
├── Cargo.toml            Crate `nebula` / lib `nebula_lib`. Desktop-only deps (updater, autostart, single-instance, tray) and mobile-only barcode-scanner are behind cfg targets. Release profile: LTO, opt-level "s", strip, panic=abort
├── tauri.conf.json       productName, identifier com.snowfly.nebula, window, NSIS (per-user), updater pubkey and endpoint
├── build.rs              tauri_build::build()
├── capabilities/
│   ├── default.json      All platforms: core, notification, opener, os, process
│   ├── desktop.json      updater, autostart, fullscreen get/set
│   └── mobile.json       barcode-scanner
├── icons/                Generated by `npx tauri icon app-icon.svg` (includes icons/android/** used by prepare-android)
└── src/
    ├── main.rs           Calls nebula_lib::run() (no console window in release)
    ├── lib.rs            Builder: plugins, tray menu (Open / Quit), close-to-tray, --minimized, command registry
    ├── bridge.rs         Bridge config file, CLI discovery, running and cancelling agents, Codex rate limits, one-time upgrade cleanup
    └── sys.rs            sys_stats (CPU, per-core, memory, network deltas, uptime, process count, OS) and keep_awake
```

### Tauri commands (called with `invoke` from `src/bridge/native.ts` and `BridgeApp.tsx`)

| Command | Purpose |
| --- | --- |
| `load_config` / `save_config` | Read and write `~/.nebula/bridge.json` (or `$NEBULA_CONFIG_DIR/bridge.json`). Missing file → defaults |
| `host_info` | `{ machine, home, claudePath, codexPath }`. Detects the CLIs (search order below) |
| `run_agent` | Spawns `{ program, args, cwd, stdin }` with no window. Emits every JSON stdout line as the `agent-event` event `{ runId, event }`. Returns `{ exitCode, stderr, cancelled }` |
| `cancel_agent` | Kills the run with that `runId` (the engine uses the message id as the runId) |
| `codex_rate_limits` | Reads the newest `rate_limits` from `$CODEX_HOME/sessions/**/rollout-*<thread>*.jsonl` |
| `sys_stats` | Telemetry sample; CPU values are deltas, so poll it about once a second |
| `keep_awake` | `SetThreadExecutionState` on Windows; does nothing elsewhere |
| `remove_legacy_install` | One-time cleanup of an older install (see §8) |

**CLI detection:**
- **Claude:** `~/.local/bin/claude(.exe)` → `PATH` → the newest version folder under `%APPDATA%\Claude\claude-code\` or the MSIX-virtualized `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code\` (the copy bundled with the Claude desktop app).
- **Codex:** `codex(.exe)` on `PATH` → the native binary inside the global npm package `@openai/codex` (preferred over `codex.cmd`, so cancelling kills Codex itself) → `~/.local/bin` or `~/.cargo/bin` → `codex.cmd`.
- The config's `claudePath` and `codexPath` override detection.

**Desktop behaviour:** single instance (a second launch focuses the window), tray icon (left-click opens the window; menu has Open Nebula / Quit bridge), close hides to tray, autostart at login with `--minimized`.

## 5. Database: `supabase/migrations/`

Applied in filename order. The last migration, `20260929180000_nodes.sql`, defines the current schema; the earlier ones are history. On a brand-new project all of them run in order (see [development.md](development.md#supabase)).

### Tables

| Table | Key columns | Notes |
| --- | --- | --- |
| `nodes` | `id, name, operator_email, agent_email (unique), machine` | Emails are lower-case. A trigger stops one email from being both an operator and an agent. Clients may update only `name` and `machine` |
| `agents` | `id, node_id, kind, name, online, paused, activity, current_chat_id, machine, version, last_seen, usage jsonb` | Unique on `(node_id, kind)`. The bridge upserts it `onConflict: 'node_id,kind'` |
| `chats` | `id, node_id, agent_id, title, session_id, preview, last_sender, updated_at` | Triggers fix `node_id` from the agent; `node_id` and `agent_id` can't change |
| `messages` | `id, node_id, chat_id, sender, body, status, reply_to, meta jsonb` | `sender ∈ user/agent/system`; `status ∈ sent/queued/processing/done/error/cancelled`; body is 1–100000 chars |
| `login_requests` | `node_id, email, code, expires_at (+5 min)` | Written by `request-code`. The bridge reads its own node's rows |
| `pair_requests` | `code (8 chars), secret, machine, node_id, agent_email, agent_code, expires_at (+10 min)` | Only the `pair` function touches it (RLS on, no policies) |

### Functions and triggers
- `my_email()`: the lower-cased JWT email.
- `operates(node)`, `runs(node)`, `sees(node)`: whether the caller is that node's operator, its agent, or either. **All RLS policies are built from these three.**
- `guard_signup()` (trigger on `auth.users`): only emails that appear in `nodes` can sign up.
- `chats_pin_node`, `messages_pin_node`: fill in `node_id` from the parent row and keep it fixed.
- `messages_bump_chat`: on insert, updates the chat's `preview`, `last_sender`, `updated_at`, and `title` (from the first user message). Skips `/stop`, `/new` and `/status`.
- `touch_updated_at`: keeps `updated_at` current on agents and messages.
- `claim_next_message(p_agent uuid)`: atomic `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` that takes the oldest queued user message for that agent, only if the caller `runs` the node. Executable by `authenticated`.

### RLS summary
| Table | Operator (phone) | Agent (bridge) |
| --- | --- | --- |
| nodes | read, rename, delete | read, rename |
| agents | read | read, insert, update |
| chats | read, create (no session_id), update, delete | read, update |
| messages | read; insert `user` + `queued`; update `queued → cancelled` | read; insert `agent`/`system`; update any |
| login_requests | none | read own node's |

**Realtime publication:** `nodes, agents, chats, messages, login_requests`. `messages` and `chats` use `replica identity full`, so DELETE events include the old row.

## 6. Edge functions: `supabase/functions/`

Both run on Deno, use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (which Supabase provides automatically), and are **deployed with `verify_jwt = false`**. The pairing PC has no session, and the publishable key is not a JWT. Errors come back as `{ error }`, which `callFn` turns into a thrown message.

| Function | Actions |
| --- | --- |
| `request-code` | `{ email }`: if the email operates any node, creates the user if needed, mints an email OTP with `generateLink('magiclink')`, and inserts a `login_requests` row per node. Rate limit: 5 × number of nodes per 15 minutes. Gives the same `{ ok }` whether or not the email exists |
| `pair` | `start {machine}` (PC) → `{id, code, secret, expires_at}`; max 20 open requests. `status {id, secret}` (PC) → `pending / expired / approved {email, code}`; the code is handed over once. `peek {code}` (operator) → `{machine}`. `approve {code, name, operator_email, agent_email}` (operator) creates or updates the node, mints the agent's code, and returns `operator_code` if the operator email differs from the caller's |

Code alphabet: `A–Z` and `2–9` without `0 O 1 I`, so a code can be typed from the screen.

## 7. Protocols and formats

### QR payloads (`src/lib/config.ts`)
- Sign-in: `nebula:login:<email>:<6–10 digits>`
- Pairing: `nebula:pair:<8 chars>`

### Bridge config: `~/.nebula/bridge.json`
Stored outside AppData so tools running inside MSIX-packaged apps see the same file. `NEBULA_CONFIG_DIR` points a second bridge at another folder, which is useful for testing pairing on one PC.

```json
{
  "auth": { "nebula-bridge": "<supabase session, written by the app>" },
  "workspace": "C:\\Users\\you",
  "permissionMode": "bypassPermissions",
  "claudePath": "", "model": "",
  "codexPath": "", "codexModel": "",
  "pausedAgents": [],
  "serviceKey": "", "sessionId": ""
}
```
`serviceKey` and `sessionId` are legacy fields (see §8). An empty `workspace` means the user's home folder. The `BridgeConfig` shape is defined twice, in Rust (`bridge.rs`) and TypeScript (`native.ts`); **change both together**.

### Protocol for any agent process
Any process signed in as a node's agent email can act as an agent. The built-in adapters follow the same steps:
1. **Heartbeat** about every 20 seconds: upsert `agents { node_id, kind, name, online: true, last_seen, machine, version }` on conflict `node_id,kind`, and keep the returned `id`. On exit set `online: false`.
2. **Claim:** `rpc('claim_next_message', { p_agent: id })` returns one message or none.
3. **Context:** read `chats.session_id` for `message.chat_id`, resume it, and write back a new id if it changes.
4. **Progress:** update `agents.activity` (one short line) and `current_chat_id`; clear both when done.
5. **Reply:** insert `{ chat_id, sender: 'agent', body, status: 'sent', reply_to: message.id, meta: { agent, duration_ms, … } }`, then set the user message to `done` or `error` (or `cancelled`).
6. **Commands:** `/stop` (realtime insert; cancel the run in that chat), `/new` (clear `session_id`), `/status`.

### `messages.meta` (agent replies)
`agent, cost_usd, duration_ms, session_id, is_error, turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model`. The Usage screen adds these up.

### `agents.usage`
`{ windows: [{ id, label, pct (0–100), resets_at }], status?, at }`. Claude's comes from `rate_limit_event` in its stream (`unifiedWindows`, or the single binding window on older CLIs). Codex's comes from its session rollout log (`primary` and `secondary`).

## 8. Legacy shims (mostly safe to remove in a fresh deployment)

Some code only exists to upgrade machines from an earlier single-PC release that used a different app name and config folder. A fresh install never runs it:
- `bridge.rs`: `adopt_legacy_config()` (copies an old config folder) and `remove_legacy_install()` (removes an old app's autostart entry and uninstalls it). `BridgeApp.tsx` calls the latter once, recorded in `localStorage['nebula.legacyRemoved']`.
- `auth.ts`: `adoptServiceKey()` (uses a leftover `serviceKey` once to sign in as the agent, then clears it). **Keep this one, or replace it first:** it is also the easiest way to sign in the first PC of a brand-new project (see [development.md §5](development.md#bootstrapping-a-brand-new-supabase-project)).
- `BridgeConfig.sessionId` and `serviceKey`.
- `phone/accounts.ts`: `adoptLegacySession()` (moves a single pre-accounts session key into the accounts list).
- Early migrations that create and later drop `allowed_users`, `agent_state` and `login_codes`.

If you remove these, remove the Rust and TS config fields together, and check that `connect()` still reads cleanly.

## 9. Where to make common changes

| Change | Where |
| --- | --- |
| Add a coding agent | New `AgentAdapter` in `src/bridge/agents.ts` + add it to `ADAPTERS`; CLI detection in `bridge.rs` (`find_*`, `HostInfo`) and `native.ts` (`HostInfo`); path and model fields in `BridgeConfig` (Rust + TS) and `ConfigForm` |
| New phone screen | `src/phone/*` + a `View` and `history` entry in `PhoneApp.tsx` `Home` + a menu item in `ChatList.tsx` |
| New console panel | `BridgeApp.tsx` (Console) + `ops.css`; reusable pieces in `widgets.tsx` |
| New native capability | Command in `src-tauri/src/*.rs` → register in `lib.rs` `generate_handler!` → typed wrapper in `src/bridge/native.ts`; plugin permissions in `capabilities/*.json` |
| Schema or RLS change | A **new** migration file `supabase/migrations/YYYYMMDDHHMMSS_name.sql` (never edit applied ones) + update `src/lib/types.ts`; add new tables to the realtime publication if clients subscribe |
| Server-side privileged action | New or changed edge function in `supabase/functions/<name>/index.ts`, called with `callFn` |
| Backend project or repo coordinates | `src/lib/config.ts` (`SUPABASE_URL`, `SUPABASE_KEY`, `GITHUB_REPO`) + `tauri.conf.json` updater endpoint |
| Theme | CSS variables at the top of `src/styles.css`; console styles in `src/bridge/ops.css` |
