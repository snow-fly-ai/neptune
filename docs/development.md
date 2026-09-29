# Nebula: development

Tools, setup and day-to-day commands. For the code layout, see [architecture.md](architecture.md). For shipping, see [releasing.md](releasing.md).

---

## 1. Tools

| Tool | Version | Needed for | Notes |
| --- | --- | --- | --- |
| Node.js + npm | **22+** (CI uses 22; also works on 24) | Everything | `npm ci` uses `package-lock.json` |
| Rust (rustup) | **stable**, 1.85 or newer (edition 2021; recently built with 1.98) | Desktop and Android builds | `rustup default stable` |
| Windows C++ toolchain | Visual Studio 2022 Build Tools, "Desktop development with C++" | Desktop build on Windows | Use the **MSVC** Rust toolchain (`stable-x86_64-pc-windows-msvc`), the same one CI uses. The `gnullvm` toolchain can compile, but linking the `cdylib` fails with a symbol-limit error |
| WebView2 Runtime | Any recent | Running the desktop app | Preinstalled on Windows 11 |
| Tauri CLI | 2.x (`@tauri-apps/cli` devDependency, currently 2.11) | `npx tauri …` | No global install needed |
| Git + GitHub CLI (`gh`) | Any recent | Releases, CI logs | `gh auth login` |
| Supabase CLI | Latest (optional) | Applying migrations and deploying edge functions from the terminal | You can use the Supabase dashboard instead |
| **Android only:** JDK | **17** (Temurin) | APK builds | Set `JAVA_HOME` |
| **Android only:** Android SDK + NDK | Latest SDK platform and build-tools; latest NDK | APK builds | Set `ANDROID_HOME` and `NDK_HOME`. Android Studio is the easiest way to install them |
| **Android only:** Rust target | `aarch64-linux-android` | APK builds | `rustup target add aarch64-linux-android` (add `armv7-linux-androideabi`, `i686-linux-android` and `x86_64-linux-android` for emulators or `tauri android dev`) |

### Agent CLIs (on the PC that runs the bridge)
The bridge runs whichever of these it finds, and ignores the rest.
- **Claude Code:** the standalone install (`~/.local/bin/claude.exe`), anything on `PATH`, or the copy bundled with the Claude desktop app. Sign it in once with `claude auth login`.
- **Codex:** `npm i -g @openai/codex`. Sign it in once with `codex login`.

## 2. Configuration and environment

There is **no `.env` file**. Client configuration is compiled in from `src/lib/config.ts`:

| Constant | Meaning |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase **publishable** key. Safe to ship, because RLS guards the data. **Never put the service-role key in client code.** |
| `GITHUB_REPO` | `owner/name`, used by the phone app to look for APK updates |
| `ONLINE_WINDOW_MS` | 75 s: how recent a heartbeat must be for an agent to count as online |

The desktop updater endpoint and public key are in `src-tauri/tauri.conf.json` (`plugins.updater`).

### Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `NEBULA_CONFIG_DIR` | Bridge (Rust) | Use `<dir>/bridge.json` instead of `~/.nebula/bridge.json`. Lets a second, test bridge run on the same PC |
| `TAURI_DEV_HOST` | `vite.config.ts` | Set by `tauri android dev` so the phone can reach the dev server |
| `CODEX_HOME` | Bridge (Rust) | Where Codex keeps its session logs (default `~/.codex`); read for plan usage |
| `NPM_CONFIG_PREFIX` | Bridge (Rust) | An extra place to look for a globally installed Codex |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `tauri build` | Needed only for signed updater builds (CI). Without them a local `tauri build` fails at the updater-signing step, so use `--no-bundle` locally |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Edge functions | Supabase provides these automatically; nothing to set |

### Bridge config
The bridge's runtime settings and its auth session are in `~/.nebula/bridge.json` (format in [architecture.md §7](architecture.md#7-protocols-and-formats)). The app writes this file; you normally change it from the console's **Config** dialog. It holds a live session, so never commit it or paste it anywhere.

## 3. First-time setup

```bash
git clone <repo-url>
cd <repo>
npm ci
```

Check that it compiles:

```bash
npx tsc --noEmit
```

```bash
npm run build
```

```bash
cd src-tauri && cargo check
```

`cargo check` needs `dist/` to exist, because `tauri::generate_context!` embeds the frontend. Run `npm run build` first.

## 4. Running locally

### A. UI only, in a browser (fastest)
```bash
npm run dev
```
Vite serves on `http://localhost:1420` (strict port). There is no native side in the browser:

| URL | Shows |
| --- | --- |
| `/?mode=bridge` | The desktop console with a fake "Preview" node and simulated telemetry. It doesn't sign in or run agents |
| `/?mode=bridge&pair` | The PC pairing screen (it really calls `pair` → `start` on the backend) |
| `/?mode=phone` or `/` | The phone app, against the **real** backend. You can sign in by typing the code a PC shows. There's no camera, so the QR buttons are hidden |

A narrow browser window (about 400 px) approximates the phone.

### B. Desktop bridge (Tauri)
```bash
npx tauri dev
```
This runs `npm run dev` and opens the native window. **Warning:** by default it uses the same `~/.nebula/bridge.json` and app identifier as an installed Nebula. It would sign in as the real PC and take work from the real queue, and the single-instance plugin would just focus the installed app. To test next to an installed bridge:

1. Create an uncommitted override file, for example `src-tauri/tauri.dev.local.json`:
   ```json
   { "identifier": "com.snowfly.nebula.dev", "productName": "Nebula Dev" }
   ```
2. Run it with its own config folder:
   ```powershell
   $env:NEBULA_CONFIG_DIR = "$env:TEMP\nebula-dev"; npx tauri dev --config src-tauri/tauri.dev.local.json
   ```
3. It starts on the pairing screen. Pair it from the phone as a separate **test node** with throwaway emails, and remove the node when you're done (phone › PCs › Remove).

To get a release binary without the installer or updater signing:
```bash
npx tauri build --no-bundle
```
The output is `src-tauri/target/release/nebula.exe`. On the GNU toolchain the exe also needs `WebView2Loader.dll` next to it.

### C. Phone app (Android)
```bash
npx tauri android init
```
This generates `src-tauri/gen/android`, which is git-ignored. Run it once, and again after changing identifiers or plugins.

```bash
npx tauri android dev
```
This runs on a connected device or emulator with hot reload.

- CI replaces the generated activity with `android/MainActivity.kt` and copies in the launcher icons from `src-tauri/icons/android`. For the same look locally, copy them by hand. `scripts/prepare-android.mjs` does this too, but it also patches release signing, which fails without `gen/android/keystore.properties`.
- A local release APK needs a keystore (see [releasing.md](releasing.md)):
  ```bash
  npx tauri android build --apk --target aarch64
  ```
- The QR scanner only works in the Android app. `canScan()` checks for it, and elsewhere codes are typed.

## 5. Supabase

- Project URL and publishable key are in `src/lib/config.ts`. There's no `supabase/config.toml`, and nothing runs against a local Supabase stack. Development uses the hosted project.
- **Migrations:** add a new file `supabase/migrations/YYYYMMDDHHMMSS_description.sql`. Never edit one that has already been applied. Apply it with `supabase link --project-ref <ref>`, then `supabase db push`, or paste it into the SQL editor. After a schema change, update `src/lib/types.ts`. If clients subscribe to a new table, add it to the `supabase_realtime` publication.
- **Edge functions:** deploy **without JWT verification**:
  ```bash
  supabase functions deploy pair --no-verify-jwt
  ```
  ```bash
  supabase functions deploy request-code --no-verify-jwt
  ```
- **Auth settings:** the Email provider must be enabled. Codes are 6 digits by default, and the parser accepts 6–10. Nothing is ever emailed: codes are minted with the admin API and shown on the PC.
- **Changes hit production immediately.** There is one hosted project, and it is also production. Schema changes affect the installed apps right away. Make changes backward compatible, or ship the matching app release at the same time. Test with throwaway nodes and emails, and delete them afterwards (deleting a node cascades to its agents, chats and messages; delete the auth users too).

### Bootstrapping a brand-new Supabase project
Pairing needs a signed-in operator, and an operator must already belong to a node. So **the first node has to be inserted with SQL**:
1. Create the project, apply all migrations in order, and deploy both functions.
2. The nodes migration seeds one node with the original owner's emails. For a different owner, change that `insert` before applying, or run this afterwards:
   ```sql
   insert into public.nodes (name, operator_email, agent_email, machine)
   values ('Home', '<operator email>', '<agent email>', '<PC name>');
   ```
3. Put the new URL and publishable key in `src/lib/config.ts`.
4. Sign in the first PC. The phone can't sign in yet, because a PC has to show its code, so start the PC from the service key:
   1. Put `"serviceKey": "<service-role key>"` in that PC's `~/.nebula/bridge.json`.
   2. Start the bridge. `adoptServiceKey()` in `src/bridge/auth.ts` picks the node whose `machine` matches the PC name (or the only node there is), signs in as its agent email, and **deletes the key from the file**.
   3. Sign in the phone as the operator; that PC now shows the QR.
   4. Pair further PCs from the phone as usual.

   If that code path has been removed, mint an OTP for the agent email with the admin API (`generateLink({ type: 'magiclink' })` → `email_otp`) and call `verifyOtp` in the bridge once.

## 6. Checks before committing

There is no automated test suite or linter in the repo. Before committing, at minimum:

```bash
npx tsc --noEmit
```

```bash
npm run build
```

```bash
cd src-tauri && cargo check
```

Also:
- UI changes: look at `/?mode=bridge`, `/?mode=bridge&pair` and the phone view at phone width in `npm run dev`.
- Backend or protocol changes: run the real flow end to end with a test node (pair → sign in → send a task → reply → `/stop` → remove).
- Run the Rust side's formatter:
  ```bash
  cd src-tauri && cargo fmt
  ```

## 7. Conventions

- **TypeScript is strict** (`noUnusedLocals`, `noUnusedParameters`). Unused imports break the build.
- Functional React components and hooks. The bridge engine is a plain class exposed through `useSyncExternalStore`. There's no state library.
- Plain CSS: global tokens and phone styles in `src/styles.css`, console styles in `src/bridge/ops.css`. There's no CSS framework.
- Short doc comments (`/** … */`) on exported functions and anything non-obvious. The comments explain *why*.
- User-facing text is short, plain and friendly. The phone can't see the PC, so errors say what to do ("Run `claude auth login` on the PC once").
- Keep the Rust side thin. It runs processes and reads the OS; product logic belongs in TypeScript.
- `BridgeConfig` is defined in both `bridge.rs` and `native.ts`. Change them together.
- Keep version numbers in sync only with `node scripts/bump.mjs X.Y.Z`.
- Line endings are LF (`.gitattributes`).
