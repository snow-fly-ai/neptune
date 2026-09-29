# Nebula: releasing and updates

How builds are made and shipped, how installed apps update themselves, and what to change when the repository moves. See [overview.md](overview.md) for the product and [development.md](development.md) for local builds.

---

## 1. Release flow

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a `v*` tag is pushed.

```bash
node scripts/bump.mjs X.Y.Z
```
This updates the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.

```bash
git commit -am "Release X.Y.Z"
```

```bash
git tag vX.Y.Z
```

```bash
git push
```

```bash
git push origin vX.Y.Z
```

Push the tag by name. `git push --follow-tags` only pushes annotated tags, so a lightweight tag is silently left behind.

Watch the run:

```bash
gh run watch
```

The workflow runs these jobs:
1. **create-release:** finds or creates a **draft** GitHub release for the tag.
2. **windows** (`windows-latest`): Node 22, Rust stable (MSVC), `npm ci`, then `tauri-action` builds the NSIS installer. It signs the updater artifacts and uploads `Nebula_X.Y.Z_x64-setup.exe`, its `.sig`, and `latest.json` (preferring NSIS).
3. **android** (`ubuntu-latest`): JDK 17, Rust with the `aarch64-linux-android` target, and the NDK found on the runner. It runs `tauri android init --ci`, then `scripts/prepare-android.mjs` (copies the activity and icons, patches signing). It writes `keystore.properties` from secrets, runs `tauri android build --apk --target aarch64`, and uploads `Nebula_X.Y.Z_android.apk`.
4. **publish:** takes the release out of draft and marks it **latest**.

The whole run takes about 10 minutes. A failed job leaves the release as a draft, so installed apps never see a half-published release. After fixing the problem, rerun the workflow or push the tag again.

## 2. How installed apps update

| App | Mechanism |
| --- | --- |
| Desktop bridge | `tauri-plugin-updater` reads `https://github.com/<owner>/<repo>/releases/latest/download/latest.json` (`tauri.conf.json` → `plugins.updater.endpoints`) at launch and every 3 hours. It checks the signature against `plugins.updater.pubkey`, **waits until no task is running**, installs silently (`installMode: passive`), and relaunches |
| Android app | `checkPhoneUpdate()` (`src/lib/updates.ts`) asks the GitHub API for the latest release (`GITHUB_REPO` in `src/lib/config.ts`). If it's newer than the installed version, a banner offers the `.apk` download. Android installs it over the old one only if it's signed with **the same keystore** |

Both use public, unauthenticated GitHub URLs. **If the repository is private, updates stop working.** Either keep the repo that hosts releases public, or host `latest.json` and the release files somewhere public and point both mechanisms there.

An installed bridge restarts when it updates. Any task still marked `processing` is reported to the phone as interrupted rather than rerun.

## 3. Secrets and signing keys

Repository secrets that the workflow needs:

| Secret | Purpose | How to create |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Signs desktop update bundles | `npx tauri signer generate -w nebula.key` prints the key; its **public** key goes into `tauri.conf.json` → `plugins.updater.pubkey` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key's password | Chosen when generating |
| `ANDROID_KEY_BASE64` | Release keystore, base64-encoded | `keytool -genkey -v -keystore nebula.jks -keyalg RSA -keysize 2048 -validity 10000 -alias nebula`, then base64-encode the file |
| `ANDROID_KEY_PASSWORD` | Keystore and key password (the same password is used for both) | Chosen when generating |
| `ANDROID_KEY_ALIAS` | Key alias | For example `nebula` |

`GITHUB_TOKEN` is built in, and the workflow asks for `contents: write`.

**Keep the keys safe and keep using the same ones.** A new updater key means already-installed desktops reject updates until reinstalled. A new Android keystore means the APK won't install over the old one; the user has to uninstall first and loses the phone's saved sign-ins. Keystores and `*.key` files are git-ignored. Never commit them.

## 4. Moving to a new repository

Change these together:

1. `src/lib/config.ts` → `GITHUB_REPO = '<owner>/<repo>'`.
2. `src-tauri/tauri.conf.json` → `plugins.updater.endpoints[0]` = `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
3. Add the five secrets from §3 to the new repo. Reuse the existing keys so current installs keep updating. With new keys, also update `pubkey`.
4. Decide on visibility. Release downloads must stay public (see §2).
5. Installs that are already out there still check the **old** repo. Publish one last release from the old repo that contains the new coordinates. After that they follow the new repo.

Optional, only if the identity is changing:
- **App identifier** (`tauri.conf.json` → `identifier`, and the `com/snowfly/nebula` package path used by `android/MainActivity.kt` and `scripts/prepare-android.mjs`). A new identifier installs as a **separate app**. It won't update the old one, and it has its own storage and sign-ins.
- **Backend** (`SUPABASE_URL`, `SUPABASE_KEY`). See [development.md §5](development.md#bootstrapping-a-brand-new-supabase-project) for setting up a new project.

## 5. Release checklist

- [ ] The type check, frontend build and Rust check all pass. Run each of these:
  ```bash
  npx tsc --noEmit
  ```
  ```bash
  npm run build
  ```
  ```bash
  cd src-tauri && cargo check
  ```
- [ ] Any schema or edge-function changes are applied and deployed **and** work with the currently installed apps, or the release ships at the same time.
- [ ] End-to-end flow tested with a test node (pair, sign in, task, reply, stop, remove).
- [ ] Version bumped with `scripts/bump.mjs`. The tag matches the version.
- [ ] After the release: the updater JSON reports the new version:
  ```bash
  curl -sL https://github.com/<owner>/<repo>/releases/latest/download/latest.json
  ```
- [ ] After the release: all three files (`.exe`, `.sig`, `.apk`) are attached.
