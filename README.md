# Elm-AnyDesk

Windows 11 Electron desktop application for consent-based 1:1 screen sharing, optional independent audio sharing, and ephemeral private 1:1 chat.

- [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) — Canonical source of truth, requirements, security architecture, non-goals, and phased roadmap.
- [`WINDOWS_PROTOTYPE_TEST_MATRIX.md`](./WINDOWS_PROTOTYPE_TEST_MATRIX.md) — Windows 11 Taskbar/DWM & Media Capture prototype test matrix and manual GUI checklist.

## Workspace Layout

- `packages/protocol` (`@elm/protocol`) — Shared TypeScript protocol contracts, Friend Code validation (`ELM-XXXX-XXXX`), and session/invite types.
- `apps/api` (`@elm/api`) — Cloudflare Workers backend, D1 SQLite migrations (`migrations/0001_accounts_and_friend_codes.sql`), `GitHubOAuthProvider` adapter, and `SignalingCoordinator` SQLite-backed Durable Object.
- `apps/desktop` (`@elm/desktop`) — Windows 11 Electron + React + TypeScript desktop client (sandboxed, context-isolated, narrow preload bridge, locally bundled renderer).

## Local Setup Instructions (Without Secrets)

### 1. Install Dependencies
```powershell
npm install
```

### 2. Configure Local Worker Secrets (Optional for Real GitHub OAuth Flow)
Provider secrets are kept strictly on the Cloudflare Worker and are **never** bundled into the Electron app:
1. Copy [`apps/api/.dev.vars.example`](./apps/api/.dev.vars.example) to `apps/api/.dev.vars` (ignored by Git).
2. In your GitHub Developer Settings -> OAuth Apps, create a development OAuth App with Authorization callback URL `http://127.0.0.1:8787/auth/callback`.
3. Populate `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and a random `SESSION_HMAC_SECRET` in `apps/api/.dev.vars`.
4. *(If credentials are unavailable locally, the `AuthProviderAdapter` is isolated and can be tested via the automated test suite `npm test` and the desktop app's local test-double personas without deploying test authentication.)*

### 3. Apply Local D1 Database Migration
```powershell
npx wrangler d1 migrations apply elm-anydesk-db --local --config apps/api/wrangler.jsonc
```

### 4. Run Typecheck, Tests & Build
```powershell
# Run automated D1 + Worker + Durable Object SQLite test suite
npm test

# Typecheck all workspaces
npm run typecheck

# Build all workspaces
npm run build
```

### 5. Run Locally
```powershell
# Terminal 1: Start local Cloudflare Worker (D1 + SQLite Durable Object)
npm run dev:api

# Terminal 2: Launch the Windows 11 Electron desktop app
npm run start:desktop
```
