# Elm-AnyDesk — Windows 11 Consent-Based 1:1 Screen Sharing & Private Chat

Elm-AnyDesk is a Windows 11 Electron desktop application and Cloudflare Workers backend for **consent-based 1:1 screen sharing**, **optional independent audio sharing**, and **ephemeral private 1:1 chat**.

See [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) for the authoritative product requirements and [`WINDOWS_PROTOTYPE_TEST_MATRIX.md`](./WINDOWS_PROTOTYPE_TEST_MATRIX.md) for the Windows 11 verification matrix.

---

## 1. Architecture & Zero-Bill Pilot Policy

- **Separate Packaging**:
  - `@elm/desktop` (`apps/desktop`): Packaged as a standalone Windows 11 x64 desktop application (`Elm-AnyDesk.exe`) and self-contained Windows Setup Installer (`Elm-AnyDesk-Setup-0.5.0-x64.exe`). Contains zero backend code or OAuth secrets.
  - `@elm/api` (`apps/api`): Deployed separately to Cloudflare Workers (Free Tier) with Cloudflare D1 (`DB`) and SQLite-backed Durable Objects (`SIGNALING_COORDINATOR` -> `SignalingCoordinator`). Also serves the Pilot Installer Download Page at `GET /download` (`GET /`) and `GET /download/manifest.json`.
  - `@elm/protocol` (`packages/protocol`): Shared TypeScript contracts, Friend Code validation, media consent defaults, and STUN-only policy validators.
- **STUN-Only Zero-Bill Pilot (`PILOT_NETWORK_POLICY`)**:
  - Uses public STUN servers only (`stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`).
  - **No TURN relays**, **no paid services**, and **no automatic upgrades** (`publish: null`, `autoUpgradeEnabled: false`).
  - **Restrictive Network Limitation**: If a direct P2P WebRTC connection fails on a restrictive network (such as symmetric NATs or enterprise firewalls blocking outbound UDP on ports `19302`/`3478`), the app reports `RESTRICTIVE_NETWORK_STUN_ONLY_LIMITATION` with a clear diagnostic message and executes idempotent session teardown without falling back to paid TURN relays.

---

## 2. Local Setup & Environment Variables (Without Secrets)

### Prerequisites
- **OS**: Windows 11 (x64)
- **Node.js**: v22+ or v24+ with npm workspaces
- **.NET Framework x64 Compiler**: `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (included out-of-the-box on Windows 11 for compiling `wasapi-loopback.exe` and `Elm-AnyDesk-Setup-0.5.0-x64.exe`)

### Install Dependencies
```powershell
cd D:\Downloads\Elm-AnyDesk
npm install
```

### Environment Variables Template
Copy [`.env.example`](./.env.example) to `.env` (for desktop overrides) and [`apps/api/.dev.vars.example`](./apps/api/.dev.vars.example) to `apps/api/.dev.vars` (for local Wrangler Worker secrets). Never commit `.env` or `.dev.vars`.

| Variable | Scope | Description |
| :--- | :--- | :--- |
| `ELM_API_BASE_URL` | Desktop (`@elm/desktop`) | Staging Worker base URL (e.g. `https://elm-anydesk-api-staging.<subdomain>.workers.dev` or `http://127.0.0.1:8787`) |
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler CLI / CI | Your Cloudflare Account ID |
| `CLOUDFLARE_API_TOKEN` | Wrangler CLI / CI | Cloudflare API token with `Workers Scripts:Edit` and `D1:Edit` permissions |
| `GITHUB_CLIENT_ID` | Worker Secret (`@elm/api`) | GitHub OAuth App Client ID for desktop browser sign-in |
| `GITHUB_CLIENT_SECRET` | Worker Secret (`@elm/api`) | GitHub OAuth App Client Secret (stored strictly on the Worker, never in Electron) |
| `SESSION_HMAC_SECRET` | Worker Secret (`@elm/api`) | 32-byte random hex secret for signing session tokens and OAuth state |

---

## 3. Windows Build, Test & Installer Instructions

Run from the repository root (`D:\Downloads\Elm-AnyDesk`):

```powershell
# 1. Lint & policy check (verifies STUN-only, no TURN, no auto-updater, no capture evasion, no tracked secrets)
npm run lint

# 2. Typecheck all workspaces (@elm/protocol, @elm/api, @elm/desktop)
npm run typecheck

# 3. Run unit & integration tests (@elm/protocol + @elm/api Worker/DO/D1 suite)
npm test

# 4. Build all packages (protocol + Worker dry-run + Electron main/preload/renderer + WASAPI helper)
npm run build

# 5. Run the automated Electron Windows 11 verification suite (Taskbar/DWM, Auth/Invites, 5 Media Combinations, Teardown/Liveness, STUN-Only & 3rd-Attendee Presentation Isolation)
npx electron apps/desktop --run-prototype-suite

# 6. Build the standalone Windows 11 unpacked app and Setup Installer (.exe) + SHA-256 + clean-install smoke test
npm run build:installer
```

### Installer Artifacts Output (`apps/desktop/release/`)
- `apps/desktop/release/Elm-AnyDesk-Setup-0.5.0-x64.exe` — Self-contained Windows 11 x64 Setup Installer (interactive console/GUI or `--silent --install-dir="<path>"`).
- `apps/desktop/release/Elm-AnyDesk-Setup-0.5.0-x64.exe.sha256` — SHA-256 checksum file.
- `apps/desktop/release/installer-manifest.json` — Build metadata, SHA-256, and clean-install verification receipt.
- `apps/desktop/release/win-unpacked/Elm-AnyDesk.exe` — Standalone packaged Windows 11 application directory.

Verify installer checksum in PowerShell:
```powershell
Get-FileHash .\apps\desktop\release\Elm-AnyDesk-Setup-0.5.0-x64.exe -Algorithm SHA256
```

---

## 4. Cloudflare Staging Deployment Commands

Once you supply your Cloudflare account credentials and GitHub OAuth App credentials:

```powershell
# 1. Authenticate Wrangler with your Cloudflare account
npx wrangler login

# 2. Create the Staging D1 Database (once) and copy the returned database_id into apps/api/wrangler.jsonc under env.staging.d1_databases[0].database_id
npx wrangler d1 create elm-anydesk-db-staging

# 3. Apply D1 SQL migrations (0001_accounts_and_friend_codes.sql) to Staging
npm run db:migrate:staging --workspace=@elm/api

# 4. Configure Worker secrets on Staging (never committed to git)
npx wrangler secret put GITHUB_CLIENT_ID --env staging --cwd apps/api
npx wrangler secret put GITHUB_CLIENT_SECRET --env staging --cwd apps/api
npx wrangler secret put SESSION_HMAC_SECRET --env staging --cwd apps/api

# 5. Deploy the Worker, Durable Object (SignalingCoordinator), and Download Page to Staging
npm run deploy:api:staging

# 6. Verify Staging Health & Download Page
Invoke-RestMethod https://elm-anydesk-api-staging.<YOUR_SUBDOMAIN>.workers.dev/health
Invoke-RestMethod https://elm-anydesk-api-staging.<YOUR_SUBDOMAIN>.workers.dev/download/manifest.json
```

---

## 5. Rollback Steps

### A. Cloudflare Worker Staging Rollback
To immediately roll back `elm-anydesk-api-staging` to the previous working deployment version on Cloudflare:
```powershell
# List recent deployments on staging
npx wrangler deployments list --env staging --cwd apps/api

# Roll back immediately to the previous deployment
npm run rollback:api:staging
```

### B. Cloudflare D1 Database Rollback
If a future schema migration needs to be reverted on staging (while preserving or resetting pilot tables):
```powershell
# Inspect current tables on staging D1
npx wrangler d1 execute elm-anydesk-db-staging --env staging --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

### C. Windows 11 Desktop Client Rollback / Uninstall
Because automatic upgrades are disabled (`autoUpgradeEnabled: false`), each pilot participant runs the explicit installer version they installed:
1. Run `%LOCALAPPDATA%\Programs\Elm-AnyDesk\Uninstall-Elm-AnyDesk.cmd` (or uninstall **Elm-AnyDesk (Windows 11 Pilot)** from Windows 11 **Settings → Apps → Installed apps**).
2. Run the previous known-good `Elm-AnyDesk-Setup-<prev-version>-x64.exe` installer and verify its SHA-256 hash.

---

## 6. Two-PC + Third-Attendee Pilot Test Procedure

Use **PC-A (Host A)** on Network 1 (e.g., home broadband/Wi-Fi), **PC-B (Guest B)** on Network 2 (e.g., mobile hotspot or separate ISP), and **Attendee C** in an authorized meeting:

1. **Clean Install (PC-A & PC-B)**:
   - Download `Elm-AnyDesk-Setup-0.5.0-x64.exe` from the staging `/download` page, verify `Get-FileHash -Algorithm SHA256`, and run the installer on both unpinned Windows 11 PCs.
   - Launch `%LOCALAPPDATA%\Programs\Elm-AnyDesk\Elm-AnyDesk.exe`.
2. **Sign-In, Permanent Friend Code & Complete Invite Flow**:
   - Sign in on PC-A and PC-B via GitHub OAuth. Confirm each receives a permanent `ELM-XXXX-XXXX` Friend Code that persists across app restarts.
   - On PC-B, enter PC-A's Friend Code and click **Send Invite**.
   - On PC-A, verify the incoming invite displays PC-B's identity and that Microphone Audio and Device Audio both default to **OFF**.
3. **Every Supported Media Combination (`chat-only`, `video-only`, `mic-only`, `device-only`, `combined`)**:
   - Accept with all three media toggles **OFF** (`chat-only`): verify bidirectional private chat works in the Separate Chat Window with zero media tracks attached.
   - Test `video-only`, `mic-only`, `device-only` (confirming `0` video tracks are ever sent when Screen Video is OFF), and `combined` (3 separate tracks: `screenVideo`, `microphoneAudio`, `deviceAudio`).
   - Confirm media only starts after Host A clicks **Start Sharing** and that Host A can stop each source independently.
4. **Windows 11 Unpinned Taskbar Hover & Restore**:
   - Confirm no taskbar icon is shown while the window is open/restored, the taskbar icon appears while minimized, hovering shows the static Elm-AnyDesk shield logo with live Aero Peek disabled, and clicking restores the window.
5. **Disconnect & Fresh-Invite-Only Reconnect**:
   - Test top-bar **Disconnect**, app close, and network drop. Confirm all tracks stop, Guest B's viewer clears immediately, and reconnecting presence never resumes the ended session — a fresh invite from PC-B and fresh acceptance from PC-A are required.
6. **Authorized Meeting Test with Third Attendee (Presentation Window Isolation)**:
   - Open a presentation deck window and the Elm-AnyDesk **Separate Chat Window** on PC-A.
   - Share **only** the selected presentation window with Guest B and the 3rd meeting attendee (Attendee C).
   - Send messages in the Separate Chat Window and verify on Attendee C's screen that only the selected presentation window is visible and the Separate Chat Window remains completely out of the shared content.
