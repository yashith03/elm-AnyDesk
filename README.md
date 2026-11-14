# Elm-AnyDesk

Windows 11 Electron desktop application for consent-based 1:1 screen sharing, optional independent audio sharing, and ephemeral private 1:1 chat.

See [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) for the canonical source of truth, requirements, security architecture, non-goals, and phased roadmap.

## Workspace Layout

- `packages/protocol` (`@elm/protocol`) — Shared TypeScript protocol contracts and constants.
- `apps/api` (`@elm/api`) — Cloudflare Workers backend with D1 and SQLite-backed Durable Object bindings.
- `apps/desktop` (`@elm/desktop`) — Windows 11 Electron + React + TypeScript desktop client (sandboxed, context-isolated, locally bundled renderer).

## Local Commands

```powershell
# 1. Install all workspace dependencies
npm install

# 2. Typecheck all workspaces (@elm/protocol, @elm/api, @elm/desktop)
npm run typecheck

# 3. Build all workspaces (protocol dist, Cloudflare Worker dry-run bundle, Electron main/preload/renderer bundles)
npm run build

# 4. Build and launch the Windows 11 Electron desktop app
npm run dev:desktop

# 5. Start local Cloudflare Worker dev server (D1 + SQLite Durable Object)
npm run dev:api
```
