# AGENTS.md

Instructions for AI coding agents working in this repository.

## What this is
**Nebula** lets you message the coding agents on your PC (Claude Code, Codex, …) from your phone. One Tauri 2 + React + TypeScript codebase builds two apps: an **Android chat client** and a **Windows desktop bridge** that runs the agent CLIs. They talk only through **Supabase** (Postgres with RLS, Realtime, Auth, Edge Functions).

## Read these first
| Doc | Read it when |
| --- | --- |
| [docs/overview.md](docs/overview.md) | Always. It covers the product, concepts (node, operator, agent, chat), how a task flows, features, security model and stack |
| [docs/architecture.md](docs/architecture.md) | Before changing code. It covers where every file lives, the bridge engine, Tauri commands, database schema and RLS, edge functions, protocols, and **where to make common changes** |
| [docs/development.md](docs/development.md) | Before running or building anything. It covers tools and versions, environment, run modes, Supabase workflow, checks and conventions |
| [docs/releasing.md](docs/releasing.md) | Before tagging a release, touching CI, signing or updater settings, or moving the repo |

## Commands
```bash
npm ci
```
Install dependencies.

```bash
npm run dev
```
Browser preview on :1420. Add `?mode=bridge`, `?mode=bridge&pair` or `?mode=phone`.

```bash
npx tsc --noEmit
```
Type check (strict).

```bash
npm run build
```
Type check plus the Vite build into `dist/`.

```bash
cd src-tauri && cargo check
```
Rust check. Needs `dist/` to exist first.

```bash
npx tauri dev
```
Desktop bridge. **Read development.md §4B first**, because by default it acts as the real PC.

There is no test suite or linter. The type check, build and `cargo check` must all pass before you commit.

## Rules
- **The Supabase project is production.** Migrations and edge-function deploys reach the installed apps immediately.
  - Add a *new* migration file; never edit one that's been applied.
  - Keep changes backward compatible, or ship the matching app release at the same time.
  - Update `src/lib/types.ts` to match.
  - Test with throwaway nodes and emails, then delete them.
- **Deploy edge functions with `--no-verify-jwt`.** The pairing PC has no session.
- **Never put the service-role key in client code or commit `~/.nebula/bridge.json`,** which holds a live session. Clients use only the publishable key in `src/lib/config.ts`.
- **All permissions are enforced by RLS,** built from `operates()`, `runs()` and `sees()`. Any new table needs RLS enabled plus policies, and it needs adding to the `supabase_realtime` publication if clients subscribe.
- **Keep the Rust side thin.** It runs processes and reads the OS; product logic belongs in TypeScript.
- **`BridgeConfig` is defined twice,** in `src-tauri/src/bridge.rs` and `src/bridge/native.ts`. Change both together.
- **A new Tauri command** needs registering in `src-tauri/src/lib.rs` (`generate_handler!`), a typed wrapper in `src/bridge/native.ts`, and plugin permissions in `src-tauri/capabilities/*.json`.
- **Adding an agent CLI:** add an adapter to `ADAPTERS` in `src/bridge/agents.ts` and detection in `bridge.rs`. See architecture.md §9.
- **Change versions only with `node scripts/bump.mjs X.Y.Z`.** Release by pushing a `vX.Y.Z` tag by name (`git push origin vX.Y.Z`).
- **Don't make the repo that hosts releases private.** The auto-updaters use public GitHub URLs.
- **Match the existing style:**
  - Strict TypeScript, and no unused code.
  - Functional React; plain CSS using the tokens in `src/styles.css`.
  - Brief comments that explain *why*.
  - Short, plain user-facing copy that says what to do.
  - Green (`#22C55E`) for machine/agent output, blue (`#2563EB`) for structure and anything the user sends.
- **Windows is the primary dev OS.** Use the MSVC Rust toolchain.

## When implementing a feature request
1. Read overview.md and the relevant sections of architecture.md.
2. Find the touch points in the "Where to make common changes" table (architecture.md §9).
3. For schema changes, write the migration and RLS policies, apply them, and update the types.
4. Implement the change. Keep both apps working: phone mode and bridge mode share `src/lib` and `src/ui`.
5. Verify: type check, build, `cargo check`, a browser preview of the affected screens, and an end-to-end test node run for anything touching the protocol.
6. Update these docs if you changed behaviour, structure, setup or the release process.
