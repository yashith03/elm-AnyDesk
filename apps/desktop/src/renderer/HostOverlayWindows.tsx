import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MAX_CHAT_IMAGE_BYTES,
  SUPPORTED_CHAT_IMAGE_MIME_TYPES,
  validateChatImageAttachment,
} from '../shared/chat-attachments';
import type {
  HostOverlayUiState,
  VolatileSessionUiState,
} from '../shared/bridge';
import {
  buildBackgroundRgba,
  sanitizeFloatingPanelAppearance,
  type FloatingPanelAppearance,
} from '../shared/floating-panel';
import { getChatStatusDisplay } from '../shared/session-ui-status';
import type { ThemeStateSnapshot } from '../shared/theme';
import { computeHostToolbarMediaControls } from '../shared/toolbar-media';

function OverlayThemeToggleButton(props: {
  themeState: ThemeStateSnapshot;
  onToggle: () => void;
}): React.ReactElement {
  const isDark = props.themeState.mode === 'dark';
  return (
    <button
      type="button"
      data-testid="theme-toggle-button"
      className="theme-toggle-btn no-drag"
      aria-label={`Switch to ${isDark ? 'Light' : 'Dark'} theme`}
      aria-pressed={isDark}
      onClick={props.onToggle}
    >
      <span>{isDark ? 'Dark' : 'Light'}</span>
    </button>
  );
}

const HOST_TOOLTIP_DELAY_MS = 400;

interface ActiveHostTooltip {
  readonly id: string;
  readonly label: string;
  readonly anchorCenterX: number;
}

export function HostFloatingToolbarWindow(props: {
  overlay: HostOverlayUiState;
  themeState: ThemeStateSnapshot;
}): React.ReactElement {
  const { overlay, themeState } = props;
  const hostMedia = overlay.hostMediaState;
  const controls = hostMedia
    ? computeHostToolbarMediaControls({
        hostMediaState: hostMedia,
        hostMicMutedLocally: overlay.hostMicMutedLocally,
        isStartingShare: overlay.isStartingShare,
        isStartingMic: overlay.isStartingMic,
        isStartingDeviceSound: overlay.isStartingDeviceSound,
      })
    : null;

  const isScreenSharing = Boolean(hostMedia?.screenVideo.active);
  const statusLabel = isScreenSharing
    ? 'Sharing'
    : overlay.connectionState === 'connected'
      ? 'Not Sharing'
      : overlay.connectionState === 'failed'
        ? 'Failed'
        : 'Connecting';
  const statusTone = isScreenSharing
    ? 'online'
    : overlay.connectionState === 'connected'
      ? 'pending'
      : overlay.connectionState === 'failed'
        ? 'offline'
        : 'pending';

  const protection = overlay.captureProtection;

  const shellRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeTooltip, setActiveTooltip] = useState<ActiveHostTooltip | null>(
    null
  );
  const [tooltipLeftPx, setTooltipLeftPx] = useState<number>(8);

  const hideTooltip = useCallback(() => {
    if (tooltipTimerRef.current !== null) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    setActiveTooltip(null);
  }, []);

  const scheduleTooltip = useCallback(
    (id: string, label: string, targetEl: HTMLElement | null) => {
      if (tooltipTimerRef.current !== null) {
        clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = null;
      }
      if (!targetEl || !shellRef.current) {
        setActiveTooltip(null);
        return;
      }
      const shellRect = shellRef.current.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      const anchorCenterX =
        targetRect.left - shellRect.left + targetRect.width / 2;
      tooltipTimerRef.current = setTimeout(() => {
        tooltipTimerRef.current = null;
        setActiveTooltip({ id, label, anchorCenterX });
      }, HOST_TOOLTIP_DELAY_MS);
    },
    []
  );

  // Hide tooltip on window blur, visibility change, or popup/state transitions
  useEffect(() => {
    const onWindowBlur = () => hideTooltip();
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') hideTooltip();
    };
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      hideTooltip();
    };
  }, [hideTooltip]);

  useEffect(() => {
    hideTooltip();
  }, [
    isScreenSharing,
    overlay.sourcePickerOpen,
    overlay.settingsOpen,
    overlay.chatOpen,
    hideTooltip,
  ]);

  // Clamp tooltip horizontally inside the capture-protected toolbar window so it never clips
  useLayoutEffect(() => {
    if (!activeTooltip || !shellRef.current || !tooltipRef.current) return;
    const shellWidth = shellRef.current.clientWidth;
    const tipWidth = tooltipRef.current.offsetWidth;
    const edgePad = 8;
    const rawLeft = activeTooltip.anchorCenterX - tipWidth / 2;
    const clamped = Math.max(
      edgePad,
      Math.min(rawLeft, Math.max(edgePad, shellWidth - tipWidth - edgePad))
    );
    setTooltipLeftPx(Math.round(clamped));
  }, [activeTooltip]);

  const micTooltipLabel =
    controls?.myMic.state === 'active'
      ? 'Mute Mic'
      : controls?.myMic.state === 'muted'
        ? 'Unmute Mic'
        : controls?.myMic.state === 'unavailable'
          ? 'My Mic (Not Approved)'
          : 'My Mic';

  const deviceSoundTooltipLabel =
    controls?.deviceSound.state === 'active'
      ? 'Stop Device Sound'
      : controls?.deviceSound.state === 'unavailable'
        ? 'Device Sound (Not Approved)'
        : 'Device Sound';

  const peerMicTooltipLabel = overlay.peerMicActive
    ? overlay.peerMicMutedLocally
      ? 'Unmute Viewer Mic'
      : 'Mute Viewer Mic'
    : overlay.peerMicRequestPending
      ? 'Waiting for Viewer…'
      : 'Ask Viewer to Turn On Mic';

  const shareTooltipLabel =
    controls?.myScreen.state === 'sharing'
      ? 'Stop Sharing'
      : controls?.myScreen.state === 'starting'
        ? 'Starting Share…'
        : controls?.myScreen.state === 'unavailable'
          ? 'Screen Sharing (Not Approved)'
          : 'Start Sharing';

  return (
    <main
      ref={shellRef}
      className="overlay-toolbar-shell host-ui-scope"
      data-testid="floating-viewer-panel"
      style={{
        backgroundColor: 'transparent',
        fontSize: `${overlay.appearance.barTextSizePx}px`,
      }}
    >
      <div
        className="overlay-toolbar-bar"
        data-testid="floating-panel-bar"
        onPointerLeave={hideTooltip}
        style={{
          backgroundColor: buildBackgroundRgba(
            themeState.mode,
            overlay.appearance.barBgOpacity
          ),
        }}
      >
        {protection.toggleAllowed && (
          <button
            type="button"
            data-testid="capture-protection-test-toggle"
            className={`test-protection-btn no-drag ${
              protection.enabled ? 'test-on' : 'test-off'
            }`}
            aria-label={
              protection.enabled
                ? 'Capture Protection Test ON'
                : 'Capture Protection Test OFF'
            }
            aria-pressed={protection.enabled}
            onClick={() => {
              hideTooltip();
              void window.elmDesktop.setCaptureProtectionTestEnabled(
                !protection.enabled
              );
            }}
          >
            {protection.enabled ? 'Test ON' : 'Test OFF'}
          </button>
        )}

        <div
          className="floating-drag-handle host-os-drag-handle"
          data-testid="floating-panel-drag-handle"
          aria-label="Drag floating toolbar"
        >
          ⋮⋮
        </div>

        <span
          className={`presence-pill ${statusTone}`}
          data-testid="floating-transport-status"
        >
          {statusLabel}
        </span>

        <span className="floating-toolbar-divider" aria-hidden="true" />

        {/* My Mic (icon-only) */}
        <span
          className="host-tooltip-trigger no-drag"
          onPointerEnter={(e) =>
            scheduleTooltip('mic', micTooltipLabel, e.currentTarget)
          }
          onPointerLeave={hideTooltip}
          onPointerDown={hideTooltip}
        >
          <button
            type="button"
            data-testid="toolbar-my-mic-btn"
            data-state={controls?.myMic.state ?? 'stopped'}
            className={
              controls?.myMic.state === 'active'
                ? 'toolbar-icon-btn host-icon-only-btn no-drag active'
                : controls?.myMic.state === 'muted'
                  ? 'toolbar-icon-btn host-icon-only-btn no-drag muted-state'
                  : 'toolbar-icon-btn host-icon-only-btn no-drag'
            }
            disabled={!controls || controls.myMic.disabled}
            aria-pressed={controls?.myMic.pressed ?? false}
            aria-label={controls?.myMic.title ?? 'My Microphone'}
            onFocus={(e) =>
              scheduleTooltip('mic', micTooltipLabel, e.currentTarget)
            }
            onBlur={hideTooltip}
            onClick={() => {
              hideTooltip();
              void window.elmDesktop.dispatchHostToolbarAction({
                type: 'toggle-mic',
              });
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {controls?.myMic.state === 'active' ? (
                <>
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </>
              ) : (
                <>
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                  <path d="M5 10v2a7 7 0 0 0 12 5" />
                  <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </>
              )}
            </svg>
          </button>
        </span>

        {/* Device Sound (icon-only) */}
        <span
          className="host-tooltip-trigger no-drag"
          onPointerEnter={(e) =>
            scheduleTooltip(
              'device-sound',
              deviceSoundTooltipLabel,
              e.currentTarget
            )
          }
          onPointerLeave={hideTooltip}
          onPointerDown={hideTooltip}
        >
          <button
            type="button"
            data-testid="toolbar-device-sound-btn"
            data-state={controls?.deviceSound.state ?? 'stopped'}
            className={
              controls?.deviceSound.state === 'active'
                ? 'toolbar-icon-btn host-icon-only-btn no-drag active'
                : 'toolbar-icon-btn host-icon-only-btn no-drag'
            }
            disabled={!controls || controls.deviceSound.disabled}
            aria-pressed={controls?.deviceSound.pressed ?? false}
            aria-label={controls?.deviceSound.title ?? 'Device Sound'}
            onFocus={(e) =>
              scheduleTooltip(
                'device-sound',
                deviceSoundTooltipLabel,
                e.currentTarget
              )
            }
            onBlur={hideTooltip}
            onClick={() => {
              hideTooltip();
              void window.elmDesktop.dispatchHostToolbarAction({
                type: 'toggle-device-sound',
              });
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {controls?.deviceSound.state === 'active' ? (
                <>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </>
              ) : (
                <>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="22" y1="9" x2="16" y2="15" />
                  <line x1="16" y1="9" x2="22" y2="15" />
                </>
              )}
            </svg>
          </button>
        </span>

        {/* Peer / Viewer Mic (icon-only: request Viewer mic ON, or mute/unmute incoming Viewer mic) */}
        <span
          className="host-tooltip-trigger no-drag"
          onPointerEnter={(e) =>
            scheduleTooltip('peer-mic', peerMicTooltipLabel, e.currentTarget)
          }
          onPointerLeave={hideTooltip}
          onPointerDown={hideTooltip}
        >
          <button
            type="button"
            data-testid="toolbar-peer-mic-btn"
            data-state={
              overlay.peerMicActive
                ? overlay.peerMicMutedLocally
                  ? 'muted'
                  : 'active'
                : overlay.peerMicRequestPending
                  ? 'pending'
                  : 'stopped'
            }
            className={
              overlay.peerMicActive && !overlay.peerMicMutedLocally
                ? 'toolbar-icon-btn host-icon-only-btn no-drag active'
                : overlay.peerMicActive && overlay.peerMicMutedLocally
                  ? 'toolbar-icon-btn host-icon-only-btn no-drag muted-state'
                  : 'toolbar-icon-btn host-icon-only-btn no-drag'
            }
            disabled={!controls}
            aria-pressed={Boolean(
              overlay.peerMicActive && !overlay.peerMicMutedLocally
            )}
            aria-label={peerMicTooltipLabel}
            onFocus={(e) =>
              scheduleTooltip('peer-mic', peerMicTooltipLabel, e.currentTarget)
            }
            onBlur={hideTooltip}
            onClick={() => {
              hideTooltip();
              void window.elmDesktop.dispatchHostToolbarAction({
                type: 'toggle-peer-mic',
              });
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {overlay.peerMicActive && !overlay.peerMicMutedLocally ? (
                <>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </>
              ) : (
                <>
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                  <path d="M5 10v2a7 7 0 0 0 12 5" />
                  <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </>
              )}
            </svg>
          </button>
        </span>

        {/* My Screen — Start / Stop Sharing (icon-only, distinct icons) */}
        <span
          className="host-tooltip-trigger no-drag"
          onPointerEnter={(e) =>
            scheduleTooltip('share', shareTooltipLabel, e.currentTarget)
          }
          onPointerLeave={hideTooltip}
          onPointerDown={hideTooltip}
        >
          {controls?.myScreen.state === 'sharing' ? (
            <button
              type="button"
              data-testid="host-stop-sharing-button"
              className="toolbar-icon-btn host-icon-only-btn no-drag active"
              aria-label="Stop Sharing"
              aria-pressed={true}
              onFocus={(e) =>
                scheduleTooltip('share', shareTooltipLabel, e.currentTarget)
              }
              onBlur={hideTooltip}
              onClick={() => {
                hideTooltip();
                void window.elmDesktop.dispatchHostToolbarAction({
                  type: 'stop-screen',
                });
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <rect x="9" y="7" width="6" height="6" fill="currentColor" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              data-testid="host-start-sharing-button"
              className="primary-btn host-icon-only-btn no-drag"
              disabled={!controls || controls.myScreen.disabled}
              aria-label={
                controls?.myScreen.state === 'starting'
                  ? 'Starting screen share'
                  : 'Start Sharing'
              }
              aria-pressed={false}
              onFocus={(e) =>
                scheduleTooltip('share', shareTooltipLabel, e.currentTarget)
              }
              onBlur={hideTooltip}
              onClick={() => {
                hideTooltip();
                void window.elmDesktop.dispatchHostToolbarAction({
                  type: 'start-screen',
                });
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <polygon points="10 7 16 10 10 13 10 7" fill="currentColor" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </button>
          )}
        </span>

        {/* Source Picker (icon-only) */}
        <span
          className="host-tooltip-trigger no-drag"
          onPointerEnter={(e) =>
            scheduleTooltip('source', 'Select Source', e.currentTarget)
          }
          onPointerLeave={hideTooltip}
          onPointerDown={hideTooltip}
        >
          <button
            type="button"
            data-testid="host-source-picker-toggle"
            className={
              overlay.sourcePickerOpen
                ? 'toolbar-icon-btn host-icon-only-btn no-drag active'
                : 'toolbar-icon-btn host-icon-only-btn no-drag'
            }
            disabled={!controls || controls.sourcePicker.disabled}
            aria-expanded={overlay.sourcePickerOpen}
            aria-label="Select window or display source"
            onFocus={(e) =>
              scheduleTooltip('source', 'Select Source', e.currentTarget)
            }
            onBlur={hideTooltip}
            onClick={() => {
              hideTooltip();
              void window.elmDesktop.toggleHostSourcePickerPopup();
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="14" height="11" rx="2" />
              <path d="M7 19h12a2 2 0 0 0 2-2V9" />
            </svg>
          </button>
        </span>

        {/* Chat Popup (icon-only) */}
        <span
          className="host-tooltip-trigger no-drag"
          onPointerEnter={(e) =>
            scheduleTooltip('chat', 'Private Chat', e.currentTarget)
          }
          onPointerLeave={hideTooltip}
          onPointerDown={hideTooltip}
        >
          <button
            type="button"
            data-testid="floating-chat-toggle"
            className={
              overlay.chatOpen
                ? 'toolbar-icon-btn host-icon-only-btn no-drag active'
                : 'toolbar-icon-btn host-icon-only-btn no-drag'
            }
            aria-pressed={overlay.chatOpen}
            aria-label="Toggle private Chat popup"
            onFocus={(e) =>
              scheduleTooltip('chat', 'Private Chat', e.currentTarget)
            }
            onBlur={hideTooltip}
            onClick={() => {
              hideTooltip();
              if (overlay.chatOpen) {
                void window.elmDesktop.closeSeparateChatWindow();
              } else {
                void window.elmDesktop.openSeparateChatWindow();
              }
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {overlay.hasUnreadChat && (
              <span
                className="chat-unread-dot"
                data-testid="chat-unread-dot"
                aria-hidden="true"
              />
            )}
          </button>
        </span>

        {/* Settings Popup (icon-only) */}
        <span
          className="host-tooltip-trigger no-drag"
          onPointerEnter={(e) =>
            scheduleTooltip('settings', 'Appearance Settings', e.currentTarget)
          }
          onPointerLeave={hideTooltip}
          onPointerDown={hideTooltip}
        >
          <button
            type="button"
            data-testid="floating-settings-toggle"
            className={
              overlay.settingsOpen
                ? 'toolbar-icon-btn host-icon-only-btn no-drag active'
                : 'toolbar-icon-btn host-icon-only-btn no-drag'
            }
            aria-expanded={overlay.settingsOpen}
            aria-label="Appearance settings"
            onFocus={(e) =>
              scheduleTooltip(
                'settings',
                'Appearance Settings',
                e.currentTarget
              )
            }
            onBlur={hideTooltip}
            onClick={() => {
              hideTooltip();
              void window.elmDesktop.toggleHostSettingsPopup();
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </span>

        <span className="floating-toolbar-divider" aria-hidden="true" />

        {/* End Session (icon-only) */}
        <span
          className="host-tooltip-trigger no-drag"
          onPointerEnter={(e) =>
            scheduleTooltip('end-session', 'End Session', e.currentTarget)
          }
          onPointerLeave={hideTooltip}
          onPointerDown={hideTooltip}
        >
          <button
            type="button"
            data-testid="floating-end-session"
            className="danger-btn host-icon-only-btn no-drag"
            aria-label="End Session"
            onFocus={(e) =>
              scheduleTooltip('end-session', 'End Session', e.currentTarget)
            }
            onBlur={hideTooltip}
            onClick={() => {
              hideTooltip();
              void window.elmDesktop.dispatchHostToolbarAction({
                type: 'end-session',
              });
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </span>
      </div>

      {activeTooltip && (
        <div
          ref={tooltipRef}
          role="tooltip"
          data-testid="host-toolbar-tooltip"
          data-tooltip-id={activeTooltip.id}
          className="host-toolbar-tooltip"
          style={{ left: `${tooltipLeftPx}px` }}
        >
          {activeTooltip.label}
        </div>
      )}
    </main>
  );
}

export function HostSourcePickerPopup(props: {
  overlay: HostOverlayUiState;
  themeState: ThemeStateSnapshot;
}): React.ReactElement {
  const { overlay, themeState } = props;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void window.elmDesktop.toggleHostSourcePickerPopup(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const displays = overlay.shareableSources.filter(
    (s) => s.surfaceType === 'display'
  );
  const windows = overlay.shareableSources.filter(
    (s) => s.surfaceType === 'window'
  );

  const renderGroup = (
    title: string,
    items: typeof overlay.shareableSources
  ) => {
    if (items.length === 0) return null;
    return (
      <div className="host-source-group">
        <div className="host-source-group-label muted">{title}</div>
        {items.map((src) => (
          <button
            key={src.id}
            type="button"
            data-source-id={src.id}
            className={
              src.id === overlay.selectedSourceId
                ? 'host-source-option active'
                : 'host-source-option'
            }
            onClick={() => {
              void window.elmDesktop.dispatchHostToolbarAction({
                type: 'select-source',
                sourceId: src.id,
              });
              void window.elmDesktop.toggleHostSourcePickerPopup(false);
            }}
          >
            <span className="host-source-badge">
              {src.surfaceType === 'display' ? 'DISPLAY' : 'WINDOW'}
            </span>
            <span className="host-source-name">{src.name}</span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <main
      className="overlay-popup-shell host-ui-scope"
      data-testid="host-source-popover"
      role="dialog"
      aria-label="Select display or window to share"
      style={{
        backgroundColor: buildBackgroundRgba(
          themeState.mode,
          overlay.appearance.barBgOpacity
        ),
      }}
    >
      <div className="host-source-popover-header">
        <strong>Select Display / Window</strong>
        <button
          type="button"
          data-testid="host-refresh-sources-button"
          className="small-secondary-btn"
          onClick={() =>
            void window.elmDesktop.dispatchHostToolbarAction({
              type: 'refresh-sources',
            })
          }
        >
          Refresh
        </button>
      </div>
      <div className="host-source-popover-list">
        {overlay.shareableSources.length === 0 ? (
          <div className="muted" style={{ padding: '12px' }}>
            No screens or windows found. Click Refresh.
          </div>
        ) : (
          <>
            {renderGroup('Displays', displays)}
            {renderGroup('Windows', windows)}
          </>
        )}
      </div>
    </main>
  );
}

export function HostSettingsPopup(props: {
  overlay: HostOverlayUiState;
  themeState: ThemeStateSnapshot;
  onToggleTheme: () => void;
}): React.ReactElement {
  const { overlay, themeState, onToggleTheme } = props;
  const appearance = overlay.appearance;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void window.elmDesktop.toggleHostSettingsPopup(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const updateAppearance = (patch: Partial<FloatingPanelAppearance>) => {
    const next = sanitizeFloatingPanelAppearance({ ...appearance, ...patch });
    void window.elmDesktop.setFloatingAppearance(next);
  };

  return (
    <main
      className="overlay-popup-shell floating-settings-sidebar host-ui-scope"
      data-testid="floating-settings-sidebar"
      role="dialog"
      aria-label="Host appearance settings"
      style={{
        backgroundColor: buildBackgroundRgba(
          themeState.mode,
          appearance.barBgOpacity
        ),
      }}
    >
      <div className="host-source-popover-header">
        <strong>Appearance Settings</strong>
        <button
          type="button"
          className="small-secondary-btn"
          aria-label="Close settings"
          onClick={() => void window.elmDesktop.toggleHostSettingsPopup(false)}
        >
          ×
        </button>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-row">
          <span>Theme</span>
          <OverlayThemeToggleButton
            themeState={themeState}
            onToggle={onToggleTheme}
          />
        </div>

        <label className="sidebar-slider">
          <span>Toolbar Opacity: {Math.round(appearance.barBgOpacity * 100)}%</span>
          <input
            type="range"
            data-testid="settings-toolbar-opacity-slider"
            min={0.35}
            max={1}
            step={0.05}
            value={appearance.barBgOpacity}
            onChange={(e) =>
              updateAppearance({ barBgOpacity: Number(e.target.value) })
            }
          />
        </label>

        <label className="sidebar-slider">
          <span>Chat Opacity: {Math.round(appearance.chatBgOpacity * 100)}%</span>
          <input
            type="range"
            data-testid="settings-chat-opacity-slider"
            min={0.35}
            max={1}
            step={0.05}
            value={appearance.chatBgOpacity}
            onChange={(e) =>
              updateAppearance({ chatBgOpacity: Number(e.target.value) })
            }
          />
        </label>
      </div>

      <div className="sidebar-section">
        <button
          type="button"
          className="small-secondary-btn"
          onClick={() => void window.elmDesktop.restoreAndFocusMainWindow()}
        >
          Show Main Elm-AnyDesk Window
        </button>
      </div>
    </main>
  );
}

export function PrivateChatPopupWindow(props: {
  volatileState: VolatileSessionUiState | null;
  appearance: FloatingPanelAppearance;
  themeState: ThemeStateSnapshot;
  onToggleTheme: () => void;
}): React.ReactElement {
  const { volatileState, appearance, themeState, onToggleTheme } = props;
  const activeSession = volatileState?.session ?? null;
  const currentAccount = volatileState?.currentAccount ?? null;
  const messages = volatileState?.messages ?? [];
  const imageAttachments = volatileState?.imageAttachmentsByMessageId ?? {};

  const [chatInputText, setChatInputText] = useState('');
  const [chatAttachmentError, setChatAttachmentError] = useState<string | null>(
    null
  );
  const [pendingImageDataUrl, setPendingImageDataUrl] = useState<string | null>(
    null
  );
  const [pendingImageName, setPendingImageName] = useState<string | null>(null);
  const [pendingImageMimeType, setPendingImageMimeType] = useState<
    string | null
  >(null);
  const [pendingImageByteLength, setPendingImageByteLength] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const chatStatus = getChatStatusDisplay({
    dataChannelState: volatileState?.dataChannelState ?? 'closed',
  });

  const handleAttachImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setChatAttachmentError(null);
    if (!file) return;
    const normalizedMime = file.type.trim().toLowerCase();
    if (
      !(SUPPORTED_CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(
        normalizedMime
      )
    ) {
      setChatAttachmentError(
        `Unsupported image type "${file.type || 'unknown'}". Supported: PNG, JPEG, WEBP, GIF.`
      );
      return;
    }
    if (file.size <= 0 || file.size > MAX_CHAT_IMAGE_BYTES) {
      setChatAttachmentError(
        `Image must be between 1 byte and ${Math.round(
          MAX_CHAT_IMAGE_BYTES / (1024 * 1024)
        )} MB.`
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const validation = validateChatImageAttachment({
        mimeType: normalizedMime,
        byteLength: file.size,
        dataUrl: reader.result,
      });
      if (!validation.ok) {
        setChatAttachmentError(validation.error);
        return;
      }
      setPendingImageDataUrl(reader.result);
      setPendingImageName(file.name);
      setPendingImageMimeType(normalizedMime);
      setPendingImageByteLength(file.size);
    };
    reader.readAsDataURL(file);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setChatAttachmentError(null);
    const rawText = chatInputText.trim();
    if (!rawText && !pendingImageDataUrl) return;
    const text =
      rawText || `[In-memory image: ${pendingImageName ?? 'image'}]`;

    await window.elmDesktop.sendChatFromChatWindow({
      text,
      imageDataUrl: pendingImageDataUrl ?? undefined,
      imageMimeType: pendingImageMimeType ?? undefined,
      imageName: pendingImageName ?? undefined,
      imageByteLength: pendingImageByteLength || undefined,
    });

    setChatInputText('');
    setPendingImageDataUrl(null);
    setPendingImageName(null);
    setPendingImageMimeType(null);
    setPendingImageByteLength(0);
  };

  return (
    <main
      className="chat-popup-shell host-ui-scope"
      data-testid="floating-panel-chat"
      style={{
        backgroundColor: buildBackgroundRgba(
          themeState.mode,
          appearance.chatBgOpacity
        ),
        fontSize: `${appearance.chatTextSizePx}px`,
      }}
    >
      <header className="chat-popup-header host-os-drag-handle">
        <div className="chat-popup-title">
          <strong>Private Chat</strong>
          <span
            className="muted"
            data-testid="floating-chat-status"
            style={{ fontSize: '0.75rem' }}
          >
            {chatStatus.label}
          </span>
        </div>
        <div className="actions-row no-drag">
          <OverlayThemeToggleButton
            themeState={themeState}
            onToggle={onToggleTheme}
          />
          <button
            type="button"
            data-testid="chat-popup-close-button"
            className="small-secondary-btn no-drag"
            aria-label="Close Chat"
            onClick={() => void window.elmDesktop.closeSeparateChatWindow()}
          >
            ×
          </button>
        </div>
      </header>

      {!activeSession ? (
        <div className="chat-popup-empty muted">
          No active session. Temporary messages and images are cleared on
          disconnect.
        </div>
      ) : (
        <>
          <div className="floating-chat-messages chat-popup-messages">
            {messages.length === 0 ? (
              <div className="muted">
                In-memory session chat over WebRTC DataChannel. Cleared when the
                session ends.
              </div>
            ) : (
              messages.map((m) => {
                const imgUrl = imageAttachments[m.messageId];
                return (
                  <div
                    key={m.messageId}
                    className={`chat-bubble ${
                      m.senderAccountId === currentAccount?.accountId
                        ? 'chat-mine'
                        : 'chat-theirs'
                    }`}
                  >
                    <div className="chat-meta">
                      <strong>{m.senderDisplayName}</strong> ·{' '}
                      {new Date(m.sentAt).toLocaleTimeString()}
                    </div>
                    {m.text && <div className="chat-text">{m.text}</div>}
                    {imgUrl && (
                      <img
                        src={imgUrl}
                        alt="In-memory shared attachment"
                        className="in-memory-image-preview"
                      />
                    )}
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {chatAttachmentError && (
            <div className="chat-error-banner" role="alert">
              {chatAttachmentError}
            </div>
          )}

          {pendingImageDataUrl && (
            <div className="pending-image-bar">
              <img
                src={pendingImageDataUrl}
                alt={pendingImageName ?? 'Pending attachment'}
                className="in-memory-image-thumb"
              />
              <span className="muted">
                {pendingImageName ?? 'Attached image'} (in memory)
              </span>
              <button
                type="button"
                className="small-secondary-btn"
                onClick={() => {
                  setPendingImageDataUrl(null);
                  setPendingImageName(null);
                  setPendingImageMimeType(null);
                  setPendingImageByteLength(0);
                  setChatAttachmentError(null);
                }}
              >
                Remove
              </button>
            </div>
          )}

          <form className="chat-input-row" onSubmit={handleSend}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={handleAttachImage}
            />
            <button
              type="button"
              className="small-secondary-btn"
              aria-label="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              Attach Image
            </button>
            <input
              type="text"
              className="code-input chat-text-input"
              placeholder="Type a private message..."
              value={chatInputText}
              onChange={(e) => setChatInputText(e.target.value)}
            />
            <button type="submit" className="primary-btn">
              Send
            </button>
          </form>
        </>
      )}
    </main>
  );
}
