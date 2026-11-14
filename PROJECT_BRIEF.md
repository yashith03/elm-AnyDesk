# Elm-AnyDesk — Project Brief (Source of Truth)

## 1. Overview & Objective
Elm-AnyDesk is a Windows 11 Electron desktop application for **consent-based 1:1 screen sharing**, **optional independent audio sharing**, and **ephemeral private 1:1 chat**.

- **Desktop Stack**: Electron, React, TypeScript, WebRTC (bundled locally).
- **Backend Stack**: Cloudflare Workers, Cloudflare D1 (SQLite), and SQLite-backed Cloudflare Durable Objects.
- **Deployment Target**: Small pilot running on **Cloudflare's Free Tier** with **STUN-only WebRTC** (no TURN servers in pilot scope).

---

## 2. Core Functional Requirements

### 2.1 Identity, Friend Code & Invite Flow
- Each signed-in account receives a **permanent, reusable, unique Friend Code**.
- A Friend Code **never expires** and **never grants automatic access** on its own.
- Peer **B** enters Peer **A**'s Friend Code to send a session invite.
- Peer **A** can explicitly **Accept** or **Decline** the incoming invite.

### 2.2 Granular Media Consent & Source Selection
- Before accepting an invite (and during a session), **A** independently controls three capture toggles:
  1. **Screen Video** (window or display selected explicitly by A — **never a webcam**).
  2. **Microphone Audio** (defaults to **OFF**).
  3. **Device / System Audio** (defaults to **OFF**).
- **B cannot enable or request activation of A's capture sources.** All capture decisions remain strictly local to A.
- Accepting an invite connects the **private 1:1 chat** channel only.
- Media streaming begins **only after A's explicit "Start Sharing" action** and completion of any required local OS/window picker selection and permissions.
- Having all three media controls **OFF** is a first-class state that permits **chat-only** sessions.
- **A** can stop (or toggle off) Screen Video, Microphone Audio, and Device Audio **independently** at any time without dropping the chat session.

### 2.3 Session Lifecycle & Termination Rules
- **No fixed time limit** is imposed on an active session.
- Any of the following events **immediately terminates the entire session (media + chat) for both participants**:
  - Either user clicking the top-bar **Disconnect** button.
  - Either user **closing the application**.
  - **Detected connection loss** (signaling heartbeat timeout or unrecoverable WebRTC/transport disconnect).
- **Minimizing a window does NOT disconnect** the session.
- **No Session Resumption**: An ended media or chat session is **never resumed**. Re-establishing a session always requires a **fresh invite** from B and **fresh acceptance** from A using the same Friend Code.
- **Online Service Reconnection Allowed**: Signing back into the account or reconnecting to the online presence/invite service (outside an active session) is permitted.

### 2.4 Windows 11 Taskbar, Thumbnail & DWM Preview Behavior
- Target environment: **Unpinned Windows 11 taskbar setup**.
- **Taskbar Icon Visibility**:
  - While the window is **open or restored**: hide the running taskbar icon (`setSkipTaskbar(true)`).
  - While the window is **minimized**: show the taskbar icon (`setSkipTaskbar(false)`) so the user can **click-to-restore** the window from the taskbar.
- **Hover Thumbnail & Aero Peek Protection**:
  - Prevent actual live window content from appearing in the Windows 11 taskbar hover thumbnail preview.
  - Implement and test Windows DWM attributes (`DWMWA_FORCE_ICONIC_REPRESENTATION` and `DWMWA_HAS_ICONIC_BITMAP` via native/FFI DWM bindings in a future phase) to supply a **static logo thumbnail** and disable full-size live **Aero Peek** (`DWMWA_DISALLOW_PEEK`).
- **Strict Zero-Popup Fallback (Documented Alternative)**:
  - On Windows 11, any visible taskbar button triggers the OS shell hover thumbnail popup container (even when displaying a static iconic bitmap).
  - If a strict product requirement demands **zero OS hover popup while minimized**, the documented alternative is keeping `setSkipTaskbar(true)` at all times and providing a **Windows System Tray (`Tray`) icon** for single-click restore. **We will not silently switch to the tray alternative** unless explicitly instructed after testing DWM iconic bitmaps.

### 2.5 Separate Chat Window & Presentation Support
- **Separate Chat Window**: Private chat runs in its own dedicated Electron `BrowserWindow`, independent of the main session/viewer window, so a presenter can keep chat on a secondary monitor or separate from a shared window.
- **Notification Previews Off**: No OS toast notifications or message content previews are shown for incoming chat messages.
- **Authorized Meetings & Rehearsals**: Supports sharing a selected presentation window or display for legitimate collaborative rehearsals and meetings.

---

## 3. Explicit Non-Goals & Prohibitions
The following features are **strictly out of scope and must never be built**:
1. **No capture-evasion features** (e.g., no `setContentProtection(true)` / `WDA_EXCLUDEFROMCAPTURE` or stealth/overlay hooks designed to hide windows from OS/third-party screen recorders).
2. **No remote keyboard or mouse control** (view-only screen sharing).
3. **No session recording** (neither local nor cloud media recording).
4. **No persistent chat history** (chat messages exist only in volatile memory for the duration of the single active session and are wiped upon disconnect).
5. **No webcam video capture** (Screen Video is strictly display/window capture).

---

## 4. Security Architecture (Desktop)
Every Electron `BrowserWindow` (both Main Window and Chat Window) enforces:
- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `webSecurity: true`
- **Local Renderer Bundling**: All renderer HTML/CSS/JS assets are bundled locally (`file://` in production builds) with a strict Content Security Policy (CSP).
- **Narrow Preload Bridge**: `contextBridge.exposeInMainWorld` exposes only typed, minimal methods; raw `ipcRenderer` or Node.js primitives are never exposed to the renderer.

---

## 5. Backend Architecture (Cloudflare Free Tier)
- **Cloudflare Workers (`apps/api`)**: Stateless HTTP API and WebSocket upgrade router.
- **Cloudflare D1**: Stores account records and permanent, unique Friend Codes.
- **SQLite-backed Durable Objects (`new_sqlite_classes`)**: Coordinates ephemeral invite state, session signaling, and heartbeat detection per session/user without persisting chat content.
- **WebRTC ICE**: Uses public STUN servers (`stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`) for NAT traversal within Cloudflare Free Tier constraints.

---

## 6. Phased Implementation Plan
- **Phase 1 (Completed)**: Project brief (`PROJECT_BRIEF.md`) and monorepo scaffold (`apps/desktop`, `apps/api`, `packages/protocol`) with local renderer bundling, strict Electron security flags, and typecheck/build verification.
- **Phase 2A (Completed — Local Windows 11 Prototype)**: Local Electron prototype verifying Windows 11 unpinned taskbar behavior (`setSkipTaskbar` + `WS_EX_APPWINDOW`), DWM static logo thumbnail (`DWMWA_FORCE_ICONIC_REPRESENTATION`, `DWMWA_HAS_ICONIC_BITMAP`, `DwmSetIconicThumbnail`) & disabled Aero Peek (`DWMWA_DISALLOW_PEEK`, `DWMWA_EXCLUDED_FROM_PEEK`), explicit window/display source picker, independent Microphone & Device Audio capture with Screen Video OFF, and the Windows-native WASAPI loopback helper (`wasapi-loopback.exe`). See [`WINDOWS_PROTOTYPE_TEST_MATRIX.md`](./WINDOWS_PROTOTYPE_TEST_MATRIX.md) for the full test matrix and reproduction steps.
- **Phase 2B (Completed — Authentication, Friend Codes, Presence & Invite Flow)**: Real desktop-safe browser OAuth provider (`GitHubOAuthProvider` via `127.0.0.1` loopback callback + `shell.openExternal`) with secrets strictly on the Worker backend, isolated `AuthProviderAdapter` + local test double (`TestDoubleAuthProvider`), permanent reusable Friend Code (`ELM-XXXX-XXXX`) in Cloudflare D1 (`0001_accounts_and_friend_codes.sql`), SQLite-backed `SignalingCoordinator` Durable Object for authenticated presence and 1:1 invite coordination, and desktop UI for My Friend Code, Copy Code, Enter Friend Code, Send Invite, and incoming Accept/Decline with Host A's three independent media consent toggles (`screenVideo`, `microphoneAudio`, `deviceAudio`).
- **Phase 3 (Completed — Approved Session WebRTC Media A → B, Reliable DataChannel Chat A ↔ B & Separate Chat Window)**: Implemented STUN-only WebRTC for approved 1:1 sessions using only the verified Windows capture paths (`desktopCapturer` + `getDisplayMedia` for explicit Window/Display Screen Video, `getUserMedia({ audio: true, video: false })` for Microphone Audio, and Windows-native `wasapi-loopback.exe` WebAudio `MediaStreamAudioDestinationNode` + Electron `audio: 'loopback'` fallback for Device Audio with Screen Video OFF). Enforced Host A's explicit "Start Sharing" action, separate tracks (`screenVideo`, `microphoneAudio`, `deviceAudio`), never attaching unchecked tracks, independent per-source stop by Host A, local-only playback controls for Guest B, specific status reporting on permission denial / source disappearance / unsupported combinations without fallback substitution or automatic video activation, and a dedicated Separate Chat Window with message previews disabled by default, zero message persistence, active-sharing indicators, and a visible stop control for Host A.
- **Phase 4 (Completed — Unified Idempotent Session Teardown, Liveness Detection & Non-Resumable Sessions)**: Implemented one idempotent session teardown path (`executeIdempotentTeardown` in `ApprovedWebRtcSessionController` + `teardownSessionIdempotent` in `SignalingCoordinator` and `DesktopAuthAndInviteController`) shared by Host A and Guest B across top-bar Disconnect (`'user_top_bar_disconnect'`), app close/quit (`'app_closed'`), OS sleep/suspend (`'connection_lost'`), and transport/liveness loss (`'connection_lost'`). Teardown stops all active Host A tracks + WASAPI loopback helper, closes both `RTCPeerConnection`s and `RTCDataChannel`s, clears Guest B's viewer (`srcObject = null`, empty received tracks, volatile chat wiped), invalidates session permissions and signaling membership, and writes a permanent tombstone (`terminated_sessions`) so any stale signal/join/poll/heartbeat is rejected with `409 SESSION_ALREADY_ENDED`. Configured `backgroundThrottling: false` so minimized sessions stay connected indefinitely while liveness heartbeats arrive, ensured network recovery or app reopen reconnects presence only (`activeSession: null`), and verified that reconnecting requires a fresh invite from B and fresh acceptance from A (`newSessionId !== oldSessionId`).

---

## 7. Recorded Assumptions
1. **Monorepo Tooling**: npm workspaces (`apps/*`, `packages/*`) with Node.js 24+ and TypeScript 5.x are used to keep dependencies simple and avoid requiring external global package managers.
2. **Friend Code Format**: Friend Codes will be formatted as human-readable, case-insensitive alphanumeric codes (e.g., `ELM-XXXX-XXXX`) generated once per account and stored with a unique constraint in Cloudflare D1.
3. **STUN-Only Connectivity**: Because the pilot targets Cloudflare's free tier with STUN-only WebRTC, peers behind symmetric NATs or restrictive enterprise firewalls that block UDP hole-punching may fail media/P2P connectivity; connection loss detection will surface this cleanly.
4. **Chat Transport**: Private chat will operate over the authenticated Durable Object WebSocket or WebRTC DataChannel tied strictly to the single accepted session ID, with zero database writes for chat messages.
5. **Windows 11 DWM Native Calls**: Applying `DWMWA_FORCE_ICONIC_REPRESENTATION`, `DWMWA_HAS_ICONIC_BITMAP`, and `DWMWA_DISALLOW_PEEK` in Phase 6 will use Windows `dwmapi.dll` via `koffi` (or a small native node addon) against the Electron `BrowserWindow.getNativeWindowHandle()` HWND on `win32`.
