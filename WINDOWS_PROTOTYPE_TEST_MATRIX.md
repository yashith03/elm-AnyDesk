# Windows 11 Prototype Test Matrix (Taskbar/DWM & Media Capture)

## 1. Environment & Versions

- **Operating System**: Microsoft Windows 11 Home — `Windows_NT 10.0.26300 (x64)` (Build `26300`)
- **Electron**: `34.5.8`
- **Chromium**: `132.0.6834.210`
- **Node.js (Electron Embedded)**: `20.19.1` (Workspace CLI Node: `v24.18.1`)
- **Native Bindings / Helpers**:
  - `koffi` FFI in `apps/desktop/src/main/win11-dwm.ts` (`dwmapi.dll`, `gdi32.dll`, `user32.dll`, `kernel32.dll`)
  - Native C# WASAPI Loopback helper in `apps/desktop/native/WasapiLoopbackHelper.cs` (`apps/desktop/dist/native/wasapi-loopback.exe`)

---

## 2. Why Visual Shell Cases Are Marked `Not Run` in Antigravity

When Electron is launched from the Antigravity command tool (`npx electron apps/desktop`), the process runs inside a restricted Windows sandbox desktop token:
- Chromium logs `Failed to assign the desktop to the current thread: 170 (ERROR_BUSY)` and `MouseCursorMonitorWin::Capture: Unable to get cursor info. Error = 5 (ERROR_ACCESS_DENIED)`.
- Because the agent cannot visually observe the interactive Windows 11 `explorer.exe` taskbar shell or move the physical mouse cursor over the taskbar button, **all visual/interactive shell verification cases are marked `Not Run`** (never claimed as `Pass`).
- All **programmatic Win32/DWM/WebRTC/WASAPI API and track invariants** that executed on Windows 11 Build 26300 are recorded below with their exact measured telemetry.

---

## 3. Windows 11 Test Matrix

| ID | Test Case | Status | Automated / Measured Result | Steps to Reproduce |
| :--- | :--- | :--- | :--- | :--- |
| **TC-01** | **Unpinned Taskbar — Window Open State (API/Style)** | **Pass** | `isMinimized: false`, `win32IsIconic: false`, `skipTaskbarApplied: true`, `wsExAppWindow: false` (`ITaskbarList::DeleteTab` + `WS_EX_APPWINDOW` cleared). | Run `npx electron apps/desktop --run-prototype-suite` or launch app and inspect "Win32 Window & Taskbar State" panel while open. |
| **TC-02** | **Unpinned Taskbar — Window Minimized State (API/Style)** | **Pass** | `isMinimized: true`, `win32IsIconic: true`, `skipTaskbarApplied: false`, `wsExAppWindow: true` (`ITaskbarList::AddTab` + `WS_EX_APPWINDOW` set). | Click **Minimize Window** in UI or run `runTaskbarMinimizeRestoreCycle`. |
| **TC-03** | **Unpinned Taskbar — Window Restored State (API/Style)** | **Pass** | `isMinimized: false`, `win32IsIconic: false`, `skipTaskbarApplied: true`, `wsExAppWindow: false` restored after 60ms settle delay. | Restore the minimized window and inspect Transition Log in UI. |
| **TC-04** | **DWM Attributes Applied (`FORCE_ICONIC`, `HAS_ICONIC_BITMAP`, `DISALLOW_PEEK`, `EXCLUDED_FROM_PEEK`)** | **Pass** | All 4 `DwmSetWindowAttribute` calls on `HWND` returned `0x00000000` (`S_OK`), and `DwmInvalidateIconicBitmaps` returned `0x00000000` (`S_OK`). | Launch app and check "DWM Attributes & Iconic Bitmap Callbacks" card. |
| **TC-05** | **DWM Static Logo Bitmap Supply (`DwmSetIconicThumbnail` & `DwmSetIconicLivePreviewBitmap`)** | **Pass** | 32-bit bottom-up BGRA DIB (`200x120`) containing only the static Elm-AnyDesk shield logo accepted by `DwmSetIconicThumbnail` (`0x00000000` `S_OK`) and `DwmSetIconicLivePreviewBitmap` (`0x00000000` `S_OK`). | Click **Trigger DWM Static Thumbnail Callback** in UI or run `--run-prototype-suite`. |
| **TC-06** | **Visual Taskbar Verification: Open → Minimize → Hover → Click-to-Restore (Unpinned)** | **Not Run** *(Manual GUI Required)* | Requires human visual verification on the interactive Windows 11 desktop taskbar (`explorer.exe`). | See **Section 5 (Manual PowerShell Launch & Step-by-Step Verification)** below. |
| **TC-07** | **Visual Hover Popup vs. Content Privacy & Disabled Full-Size Peek** | **Not Run** *(Manual GUI Required)* | Requires physical mouse hover over the minimized taskbar icon to verify: (a) OS hover popup container still appears, (b) static logo is shown with zero live `ALPHA-7392-TEST` content, and (c) full-size Peek does not trigger. | See **Section 5 (Manual PowerShell Launch & Step-by-Step Verification)** below. |
| **TC-08** | **Explicit Source Enumeration (Displays & Windows Only, No Webcam)** | **Pass** | `desktopCapturer.getSources({ types: ['screen', 'window'] })` returned only `display` / `window` surfaces (`onlyScreenOrWindow: true`). No media starts before explicit **Start Sharing**. | Click **1. Load Shareable Windows & Displays** in UI. |
| **TC-09** | **Screen Video Track Creation (`getDisplayMedia` with Selected Source)** | **Pass** | Live video `MediaStreamTrack` created (`kind: "video"`, `label: "Screen 1"`, `readyState: "live"`, `1920x1080`), cleanly transitions to `readyState: "ended"` on stop. | Select a source, check **Screen Video**, and click **2. Start Sharing**. |
| **TC-10** | **Screen Video `<video>` Element Live Frame Rendering** | **Not Run** *(Manual GUI Required)* | In the Antigravity sandbox desktop token, DXGI desktop duplication is blocked by OS `Error = 5 (ERROR_ACCESS_DENIED)`, causing `videoWidth: 0` inside the automated runner. Must be verified in interactive user desktop session. | Launch from interactive PowerShell, select a Window/Display, check **Screen Video**, click **2. Start Sharing**, and verify `<video>` preview renders live frames. |
| **TC-11** | **Independent Microphone Audio Capture & Playback (`video: false`)** | **Pass** | Live audio `MediaStreamTrack` created (`kind: "audio"`, `label: "Default - Microphone Array (2- Realtek(R) Audio)"`, `readyState: "live"`, `videoTracksCount: 0`, `<audio>` `paused: false`). | Check **Microphone Audio** (leave Screen Video OFF) and click **2. Start Sharing**. |
| **TC-12** | **Electron `getDisplayMedia({ video: false, audio: true })` with `callback({ audio: 'loopback' })` (Screen Video OFF)** | **Pass** | In Electron `34.5.8`, `setDisplayMediaRequestHandler` receives `videoRequested: false, audioRequested: true`; passing `callback({ audio: 'loopback' })` returns `audioTracks: 1` (`label: "System audio"`, `readyState: "live"`, `measuredRms: 0.074854`, `measuredPeak: 0.11414`) and `videoTracks: 0` (video never turned on). | Click **Test Electron getDisplayMedia(video: false, audio: true)** in UI. |
| **TC-13** | **Windows-Native WASAPI Loopback Prototype with Screen Video OFF** | **Pass** | `wasapi-loopback.exe` captures default render endpoint (`48000Hz`, `2ch`, `32-bit`), feeds WebAudio `MediaStreamAudioDestinationNode` (`kind: "audio"`, `readyState: "live"`, `videoTracksCount: 0`, `chunksReceived: 29`, `maxRms: 0.081152`, `maxPeak: 0.133304`), and plays in `<audio>` (`paused: false`, `currentTime: 0.51s`) with Screen Video OFF. | Check **Device Audio — WASAPI Loopback** (leave Screen Video OFF) and click **2. Start Sharing**. |
| **TC-14** | **WebRTC Chat-Only Session (`screenVideo: false, microphoneAudio: false, deviceAudio: false`)** | **Pass** | Before & after Start Sharing: `guestVideoTracks: 0`, `guestAudioTracks: 0`, `totalVideoTracksEverDeliveredToGuest: 0`. Reliable DataChannel (`ordered: true`, `reliable: true`, `state: "open"`) delivered bidirectional messages (`2`). | Run `npx electron apps/desktop --run-prototype-suite` or click **Run All 5 WebRTC Session Combinations** in UI. |
| **TC-15** | **WebRTC Video-Only Session (`screenVideo: true, microphoneAudio: false, deviceAudio: false`)** | **Pass** | Before Start Sharing: `0` tracks on B. After explicit Start Sharing: B received `videoTracksCount: 1` (`source: "screenVideo"`, `label: "Screen 1"`, `readyState: "live"`), `audioTracksCount: 0` (no unchecked audio tracks attached). | Run `npx electron apps/desktop --run-prototype-suite` or test in UI. |
| **TC-16** | **WebRTC Mic-Only Session (`screenVideo: false, microphoneAudio: true, deviceAudio: false`)** | **Pass** | Before Start Sharing: `0` tracks on B. After explicit Start Sharing: B received `videoTracksCount: 0`, `audioTracksCount: 1` (`source: "microphoneAudio"`, `label: "Default - Microphone Array (2- Realtek(R) Audio)"`), `totalVideoTracksEverDeliveredToGuest: 0`. | Run `npx electron apps/desktop --run-prototype-suite` or test in UI. |
| **TC-17** | **WebRTC Device-Only Session (`screenVideo: false, microphoneAudio: false, deviceAudio: true`)** | **Pass** | Before Start Sharing: `0` tracks on B. After explicit Start Sharing: B received `videoTracksCount: 0`, `audioTracksCount: 1` (`source: "deviceAudio"`, `label: "MediaStreamAudioDestinationNode"`), `totalVideoTracksEverDeliveredToGuest: 0` (device-only **never** delivers video). | Run `npx electron apps/desktop --run-prototype-suite` or test in UI. |
| **TC-18** | **WebRTC Combined Session + Independent Per-Source Stop + Fault Resilience** | **Pass** | B received 3 separate tracks (`videoTracksCount: 1`, `audioTracksCount: 2`, `sources: ["screenVideo", "microphoneAudio", "deviceAudio"]`). Stopping video left `2` audio tracks; stopping mic left `1` device audio track; stopping device audio left `0` media tracks with DataChannel `open`. Fault checks verified `permission_denied`, `source_disappeared`, and `unsupported` statuses while keeping remaining approved features working. | Run `npx electron apps/desktop --run-prototype-suite` or test in UI. |
| **TC-19** | **Separate Chat Window (Message Previews Off by Default, Volatile Memory Only, Active-Sharing Indicators & Stop Control)** | **Pass** | Separate `BrowserWindow` (`role=chat`) opens with `messagePreviewsDisabledByDefault: true`, shows live Host A sharing indicators and Stop controls, and wipes volatile messages (`volatileMessagesAfterDisconnectCount: 0`) on disconnect. | Click **Open Separate Chat Window** in UI or run `--run-prototype-suite`. |
| **TC-20** | **Interactive Visual Frame Rendering on B's `<video>` & Cross-Machine WAN STUN NAT Traversal** | **Not Run** *(Manual GUI / 2-PC Required)* | Inside the Antigravity sandbox desktop token, DXGI desktop pixel duplication returns `ERROR_ACCESS_DENIED (5)` and both peers run on a single host. Visual pixel rendering on B's `<video>` element and WAN STUN connectivity across two physical Windows PCs require manual verification. | Launch on an interactive Windows 11 desktop (and optionally across two physical Windows 11 PCs connected to the Worker). |

---

## 4. Architectural Findings & Trade-Off Notes

### 4.1 Taskbar Hover Popup vs. Content Privacy vs. System Tray Trade-Off
1. **Does the Windows 11 hover popup container still appear when minimized?**
   - **Yes.** Whenever a window has a visible taskbar button on Windows 11 (`setSkipTaskbar(false)` while minimized), hovering the taskbar icon instructs the Windows 11 shell (`explorer.exe`) to display the taskbar thumbnail popup container card (window title + thumbnail box + close `X` button). Windows 11 does not provide an unprivileged per-window Win32 API to suppress the shell popup frame itself while keeping a normal taskbar button, and we **do not** modify global Windows registry/Explorer settings.
2. **Is any real application content visible inside the hover popup or Peek?**
   - **No.** Because `DWMWA_FORCE_ICONIC_REPRESENTATION = 1` and `DWMWA_HAS_ICONIC_BITMAP = 1` are set on the `HWND`, DWM never captures the live window surface. Instead, DWM sends `WM_DWMSENDICONICTHUMBNAIL (0x0323)` and our main process supplies a static in-memory 32-bit BGRA Elm-AnyDesk shield logo bitmap (`DwmSetIconicThumbnail` -> `0x00000000` `S_OK`). In addition, `DWMWA_DISALLOW_PEEK = 1` and `DWMWA_EXCLUDED_FROM_PEEK = 1` disable full-size Aero Peek on hover.
3. **Documented Tray Alternative (Not Enabled Automatically)**:
   - If product requirements strictly forbid even the static-logo hover popup card while minimized, the only way on Windows 11 without changing global OS settings is keeping `setSkipTaskbar(true)` at all times (even when minimized) and placing an icon in the **Windows System Tray (`Tray`)** where single-clicking the tray icon restores the window. We have preserved the main taskbar behavior (`setSkipTaskbar(false)` on minimize) as requested.

### 4.2 Device Audio Capture with Screen Video OFF
1. **Electron 34.5.8 `setDisplayMediaRequestHandler` (`audio: 'loopback'` without `video`)**:
   - When the renderer calls `navigator.mediaDevices.getDisplayMedia({ video: false, audio: true })`, Electron 34.5.8 invokes `setDisplayMediaRequestHandler` with `request.videoRequested === false` and `request.audioRequested === true`. Returning `callback({ audio: 'loopback' })` (without any `video` property) yields a live `"System audio"` `MediaStreamTrack` with `0` video tracks (`videoTracksReturned: []`).
2. **Windows-Native WASAPI Loopback Prototype (`wasapi-loopback.exe`)**:
   - In addition to Electron's loopback handler, we built and verified `apps/desktop/native/WasapiLoopbackHelper.cs` (`dist/native/wasapi-loopback.exe`), which opens `IMMDeviceEnumerator::GetDefaultAudioEndpoint(eRender, eConsole)` with `AUDCLNT_STREAMFLAGS_LOOPBACK` completely outside Chromium's display capture stack and bridges PCM float32 frames into a WebRTC-ready `MediaStreamTrack` (`MediaStreamAudioDestinationNode`). This guarantees independent device-only audio even across Chromium versions that enforce W3C `getDisplayMedia` video constraints, while **never** turning video on automatically.

---

## 5. Manual PowerShell Launch Command & Exact Verification Steps

Run these commands in an **interactive Windows 11 PowerShell window** on your desktop (make sure the app is **not pinned** to the taskbar):

```powershell
cd D:\Downloads\Elm-AnyDesk
npm run build
npm run start:desktop
```

### Step-by-Step Manual Verification Checklist

1. **Verify Unpinned Open State (`TC-06`)**:
   - Confirm the Elm-AnyDesk window is open on your desktop and displays the yellow/crimson banner `NON-SENSITIVE LIVE WINDOW CONTENT MARKER: ALPHA-7392-TEST`.
   - Look at the Windows 11 taskbar: confirm **no Elm-AnyDesk icon is visible** on the taskbar while the window is open (`skipTaskbarApplied: true`, `WS_EX_APPWINDOW: false`).
2. **Verify Minimize & Taskbar Icon Appearance (`TC-06`)**:
   - Click the **Minimize Window (Test Taskbar Icon, Hover & Click-to-Restore)** button (or the window title bar `_` minimize button).
   - Look at the Windows 11 taskbar: confirm the **Elm-AnyDesk taskbar icon appears** while the window is minimized (`skipTaskbarApplied: false`, `WS_EX_APPWINDOW: true`).
3. **Verify Hover Thumbnail Static Logo & Disabled Peek (`TC-07`)**:
   - Move your mouse cursor over the minimized Elm-AnyDesk icon on the Windows 11 taskbar.
   - Verify separately:
     - **Hover Popup Container**: The OS thumbnail popup card appears above the taskbar icon.
     - **No Real App Content**: Inside the popup card, verify you see the **static dark-slate & blue Elm-AnyDesk shield logo** and **none** of the `ALPHA-7392-TEST` yellow/crimson banner or UI text.
     - **Full-Size Peek Disabled**: Move your mouse cursor onto the thumbnail image inside the popup and confirm Windows 11 **does not** trigger a full-screen live Aero Peek preview of the window.
4. **Verify Click-to-Restore & Taskbar Icon Hiding (`TC-06`)**:
   - Click the Elm-AnyDesk icon on the Windows 11 taskbar.
   - Confirm the window restores to the foreground, and once restored, its running icon **disappears from the Windows 11 taskbar** again.
   - Check the **Taskbar & DWM Transition Log** table inside the window to confirm `DwmSetIconicThumbnail` returned `0x00000000` (`S_OK`).
5. **Verify Explicit Source Selection & Independent Media Tracks (`TC-08` – `TC-13`)**:
   - Click **1. Load Shareable Windows & Displays** and click one of the displayed window or screen cards. Confirm no capture has started yet.
   - Check **Device Audio — WASAPI Loopback** (leave **Screen Video** unchecked/OFF) and click **2. Start Sharing (Explicit User A Action)**.
   - Confirm the **Device Audio Track (WASAPI Loopback)** card shows `Active: true`, `Screen Video Required?: NO (Active Video Tracks = 0)`, live RMS/Peak meter movement, and audible 440Hz test tone playback in the `<audio>` control.
   - Check **Screen Video**, click **2. Start Sharing**, and confirm the `<video>` preview renders live video frames from your selected window/display and **Stop Video Only** stops video without dropping Device Audio.

---

## 6. Phase 4 — Unified Idempotent Teardown, Liveness Detection & Non-Resumable Session Matrix (Windows 11 Real-Device Verified)

Verified via `npx electron apps/desktop --run-prototype-suite` on `Windows_NT 10.0.26200 (x64)` (Electron `35.7.5`, Chromium `134.0.6998.205`, Node `22.14.0`) and `npm test --workspace=@elm/api` (`5/5` tests passed). Full JSON report generated at `apps/desktop/dist/prototype-suite-report.json`.

| Case ID | Scenario | Initiator / Fault | Result | Measured Detection Time (`ms`) | Tracks Stopped / PCs & DataChannels Closed / Viewer Cleared | Stale Event Rejection | Network/App Recovery & Fresh Invite |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **P4-01** | Top-Bar Disconnect from Host A (`disconnect_from_host_a`) | `host` (`user_top_bar_disconnect`) | **PASS** | `4 ms` | `2` Host A tracks stopped, `pcHost`/`pcGuest` & both `RTCDataChannel`s closed, Guest B viewer & chat cleared | `409 SESSION_ALREADY_ENDED` | Fresh invite created new session (`newSessionId !== oldSessionId`) |
| **P4-02** | Top-Bar Disconnect from Guest B (`disconnect_from_guest_b`) | `guest` (`user_top_bar_disconnect`) | **PASS** | `5 ms` | `2` Host A tracks stopped, `pcHost`/`pcGuest` & both `RTCDataChannel`s closed, Guest B viewer & chat cleared | `409 SESSION_ALREADY_ENDED` | Fresh invite created new session (`newSessionId !== oldSessionId`) |
| **P4-03** | App Close / Quit from Host A (`app_close_from_host_a`) | `host` (`app_closed`) | **PASS** | `5 ms` | `2` Host A tracks stopped, `pcHost`/`pcGuest` & both `RTCDataChannel`s closed, Guest B viewer & chat cleared | `409 SESSION_ALREADY_ENDED` | Reopening app reconnected presence only (`activeSession: null`); fresh invite created new session |
| **P4-04** | App Close / Quit from Guest B (`app_close_from_guest_b`) | `guest` (`app_closed`) | **PASS** | `6 ms` | `2` Host A tracks stopped, `pcHost`/`pcGuest` & both `RTCDataChannel`s closed, Guest B viewer & chat cleared | `409 SESSION_ALREADY_ENDED` | Reopening app reconnected presence only (`activeSession: null`); fresh invite created new session |
| **P4-05** | Force Quit / Abrupt Loss without Close Event (`force_quit_abrupt_loss_liveness_timeout`) | Abrupt heartbeat stop (`connection_lost`) | **PASS** | `168 ms` *(160ms test threshold; 3500ms default)* | Sustained healthy session for `362 ms` (`> 2.25x` liveness threshold) with `0` teardowns first, proving liveness threshold is not a session duration limit; then stopped `2` tracks, closed PCs/DataChannels, cleared viewer | `409 SESSION_ALREADY_ENDED` | Fresh invite created new session (`newSessionId !== oldSessionId`) |
| **P4-06** | Internet Loss & Recovery on Host A (`internet_loss_and_recovery_host_a`) | Host A offline -> liveness timeout -> online | **PASS** | `144 ms` *(150ms test threshold)* | `2` Host A tracks stopped, `pcHost`/`pcGuest` & both `RTCDataChannel`s closed, Guest B viewer & chat cleared | `409 SESSION_ALREADY_ENDED` | Restoring internet reconnected presence with `activeSession: null` (never restarted media/chat); fresh invite created new session |
| **P4-07** | Internet Loss & Recovery on Guest B (`internet_loss_and_recovery_guest_b`) | Guest B offline -> liveness timeout -> online | **PASS** | `170 ms` *(150ms test threshold)* | `2` Host A tracks stopped, `pcHost`/`pcGuest` & both `RTCDataChannel`s closed, Guest B viewer & chat cleared | `409 SESSION_ALREADY_ENDED` | Restoring internet reconnected presence with `activeSession: null` (never restarted media/chat); fresh invite created new session |
| **P4-08** | Simultaneous Internet Loss & Recovery on Both Sides (`internet_loss_and_recovery_both_sides`) | Both A & B offline -> liveness timeout -> online | **PASS** | `171 ms` *(150ms test threshold)* | `2` Host A tracks stopped, `pcHost`/`pcGuest` & both `RTCDataChannel`s closed, Guest B viewer & chat cleared | `409 SESSION_ALREADY_ENDED` | Both peers reconnected online presence with `activeSession: null`; fresh invite created new session |
| **P4-09** | OS Sleep / Wake (`sleep_and_wake_non_resumable`) | `powerMonitor` suspend -> wake (`connection_lost`) | **PASS** | `5 ms` | `2` Host A tracks stopped, `pcHost`/`pcGuest` & both `RTCDataChannel`s closed, Guest B viewer & chat cleared | `409 SESSION_ALREADY_ENDED` | Wake reconnected online presence without restarting old media/chat; fresh invite created new session |
| **P4-10** | Duplicate Teardown Idempotency (`duplicate_teardown_idempotency`) | 4 concurrent/sequential teardown calls from A & B | **PASS** | `7 ms` *(1st call)* | 1st call returned `alreadyEnded: false, duplicateCallCount: 0`; calls 2–4 returned `alreadyEnded: true, duplicateCallCount: 3` with zero errors or duplicate side effects | `409 SESSION_ALREADY_ENDED` | Fresh invite created new session (`newSessionId !== oldSessionId`) |
| **P4-11** | Minimize & Restore During Active Sharing (`minimize_and_restore_during_sharing`) | Main window minimized for `752 ms` (`> 3.1x` `240 ms` liveness threshold) | **PASS** | `0 ms` *(No teardown — stayed connected)* | `stayedConnectedWhileMinimized: true`, `teardownTriggered: false`, `guestVideoTracksWhileMinimized: 1`, `guestAudioTracksWhileMinimized: 1`, `3` chat messages delivered while minimized, `dataChannelOpenAfterRestore: true` | N/A *(Session remains active)* | Clean disconnect at end of test |

---

## 7. Phase 5 — Windows 11 Installer, Cloudflare Staging & Multi-PC Pilot Matrix

| Case ID | Category | Test Case Description | Status | Evidence / Notes |
| :--- | :--- | :--- | :---: | :--- |
| **P5-01** | Lint & Policy | Repository policy & strict TypeScript lint (`npm run lint`) | **PASS** | `15/15` source files checked; zero `setContentProtection` / `WDA_EXCLUDEFROMCAPTURE`, zero `turn:`/`turns:`, zero `electron-updater`/`autoUpdater`, zero tracked secrets |
| **P5-02** | Unit & API Integration | Protocol & Cloudflare Worker/D1/DO test suite (`npm test`) | **PASS** | `2/2` `@elm/protocol` tests + `6/6` `@elm/api` tests passed (`GET /download`, `GET /download/manifest.json`, OAuth, permanent Friend Code, invite flow, WebRTC signaling gate, idempotent teardown, liveness check) |
| **P5-03** | Cloudflare Staging Dry-Run & Local D1 | Staging Worker bundle (`wrangler deploy --env staging --dry-run`) & local D1 migration (`0001_accounts_and_friend_codes.sql`) | **PASS** | `Total Upload: 73.24 KiB / gzip: 15.58 KiB`; bindings verified (`SIGNALING_COORDINATOR`, `DB: elm-anydesk-db-staging`); `4` SQL migration commands executed cleanly |
| **P5-04** | Windows 11 Installer Build & Single-PC Clean Install | Build `Elm-AnyDesk-Setup-0.5.0-x64.exe` (`110.46 MB`, SHA-256 `8e10060b69b58a97543036de78a7ef74772d66595f8409221730cac7516b7553`) and run `--silent --install-dir=<tempDir>` clean-install smoke test | **PASS** | Verified extraction of `Elm-AnyDesk.exe`, `install-receipt.json`, `Uninstall-Elm-AnyDesk.cmd`, `dist/main/index.cjs`, `dist/preload/index.cjs`, `dist/renderer/index.html`, `dist/native/wasapi-loopback.exe`, and `koffi.node` with zero backend files leaked |
| **P5-05** | STUN-Only Policy & Restrictive Network Reporting | Verify `PILOT_NETWORK_POLICY` (`stunOnly: true`, `turnEnabled: false`, `autoUpgradeEnabled: false`) and restrictive-network direct connection failure banner | **PASS** | Verified in `phase5PilotReadinessSuite.stunOnlyZeroBillPolicyCheck`: TURN URLs rejected, `restrictiveNetworkLimitationReported: true`, teardown `subReason: "restrictive_network_stun_only_direct_connection_failed"` |
| **P5-06** | Separate Chat Window Native Handle & 3rd Attendee Stream | Verify Main Window (`0xe605060000000000`) and Separate Chat Window (`0xd4062c0000000000`) have distinct Win32 `HWND`s and Attendee C receives `1` video track and `0` chat DataChannels | **PASS** *(Local Subprocess)* | `distinctNativeWindowHandles: true`, `thirdAttendeeReceivedVideoTracks: 1`, `thirdAttendeeReceivedChatChannels: 0`, `captureEvasionUsed: false` |
| **P5-07** | Live Cloudflare Staging Deployment | Deploy `elm-anydesk-api-staging` & remote D1 migration to live Cloudflare account | **NOT RUN** | Requires user-supplied `wrangler login` / `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, remote `database_id`, and GitHub OAuth credentials |
| **P5-08** | Two-PC Separate-Network Pilot & Interactive 3-Attendee Visual Test | Clean install on 2 physical Windows 11 PCs across separate networks, end-to-end WAN STUN invite/media/taskbar/disconnect flow, and 3rd-attendee live visual presentation window check | **NOT RUN** | Single local machine environment with no external Cloudflare staging credentials or second/third physical PCs on separate networks |
