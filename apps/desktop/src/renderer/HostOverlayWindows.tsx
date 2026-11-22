import React, { useEffect, useRef, useState } from 'react';
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
      title={`Current theme: ${isDark ? 'Dark' : 'Light'}`}
      onClick={props.onToggle}
    >
      <span>{isDark ? 'Dark' : 'Light'}</span>
    </button>
  );
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
      ? 'Connected'
      : overlay.connectionState === 'failed'
        ? 'Failed'
        : 'Connecting';
  const statusTone = isScreenSharing
    ? 'online'
    : overlay.connectionState === 'connected'
      ? 'online'
      : overlay.connectionState === 'failed'
        ? 'offline'
        : 'pending';

  const protection = overlay.captureProtection;

  return (
    <main
      className="overlay-toolbar-shell"
      data-testid="floating-viewer-panel"
      style={{
        backgroundColor: buildBackgroundRgba(
          themeState.mode,
          overlay.appearance.barBgOpacity
        ),
        fontSize: `${overlay.appearance.barTextSizePx}px`,
      }}
    >
      <div className="overlay-toolbar-bar" data-testid="floating-panel-bar">
        {protection.toggleAllowed && (
          <button
            type="button"
            data-testid="capture-protection-test-toggle"
            className={`test-protection-btn no-drag ${
              protection.enabled ? 'test-on' : 'test-off'
            }`}
            aria-pressed={protection.enabled}
            title="Capture Protection Test — toggle Windows capture exclusion in dev/test builds only (defaults ON)"
            onClick={() =>
              void window.elmDesktop.setCaptureProtectionTestEnabled(
                !protection.enabled
              )
            }
          >
            {protection.enabled ? 'Test ON' : 'Test OFF'}
          </button>
        )}

        <div
          className="floating-drag-handle host-os-drag-handle"
          data-testid="floating-panel-drag-handle"
          aria-label="Drag floating toolbar"
          title="Drag toolbar"
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

        {/* My Mic */}
        <button
          type="button"
          data-testid="toolbar-my-mic-btn"
          data-state={controls?.myMic.state ?? 'stopped'}
          className={
            controls?.myMic.state === 'active'
              ? 'toolbar-icon-btn no-drag active'
              : controls?.myMic.state === 'muted'
                ? 'toolbar-icon-btn no-drag muted-state'
                : 'toolbar-icon-btn no-drag'
          }
          disabled={!controls || controls.myMic.disabled}
          aria-pressed={controls?.myMic.pressed ?? false}
          title={controls?.myMic.title ?? 'Microphone'}
          aria-label={controls?.myMic.title ?? 'My Mic'}
          onClick={() =>
            void window.elmDesktop.dispatchHostToolbarAction({
              type: 'toggle-mic',
            })
          }
        >
          <svg
            width="14"
            height="14"
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
          <span>
            {controls?.myMic.state === 'active'
              ? 'Mic On'
              : controls?.myMic.state === 'muted'
                ? 'Muted'
                : controls?.myMic.state === 'unavailable'
                  ? 'Mic N/A'
                  : 'My Mic'}
          </span>
        </button>

        {/* Device Sound */}
        <button
          type="button"
          data-testid="toolbar-device-sound-btn"
          data-state={controls?.deviceSound.state ?? 'stopped'}
          className={
            controls?.deviceSound.state === 'active'
              ? 'toolbar-icon-btn no-drag active'
              : 'toolbar-icon-btn no-drag'
          }
          disabled={!controls || controls.deviceSound.disabled}
          aria-pressed={controls?.deviceSound.pressed ?? false}
          title={controls?.deviceSound.title ?? 'Device Sound'}
          aria-label={controls?.deviceSound.title ?? 'Device Sound'}
          onClick={() =>
            void window.elmDesktop.dispatchHostToolbarAction({
              type: 'toggle-device-sound',
            })
          }
        >
          <svg
            width="14"
            height="14"
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
          <span>
            {controls?.deviceSound.state === 'active'
              ? 'Sound On'
              : controls?.deviceSound.state === 'unavailable'
                ? 'Sound N/A'
                : 'Device Sound'}
          </span>
        </button>

        {/* My Screen (Start / Stop Sharing) */}
        {controls?.myScreen.state === 'sharing' ? (
          <button
            type="button"
            data-testid="host-stop-sharing-button"
            className="toolbar-icon-btn no-drag active"
            title={controls.myScreen.title}
            aria-label="Stop Sharing"
            onClick={() =>
              void window.elmDesktop.dispatchHostToolbarAction({
                type: 'stop-screen',
              })
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span>Stop Sharing</span>
          </button>
        ) : (
          <button
            type="button"
            data-testid="host-start-sharing-button"
            className="primary-btn compact-toolbar-primary no-drag"
            disabled={!controls || controls.myScreen.disabled}
            title={controls?.myScreen.title ?? 'Start Sharing'}
            aria-label="Start Sharing"
            onClick={() =>
              void window.elmDesktop.dispatchHostToolbarAction({
                type: 'start-screen',
              })
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span>
              {controls?.myScreen.state === 'starting'
                ? 'Starting…'
                : controls?.myScreen.state === 'unavailable'
                  ? 'Screen N/A'
                  : 'Start Sharing'}
            </span>
          </button>
        )}

        {/* Source Picker */}
        <button
          type="button"
          data-testid="host-source-picker-toggle"
          className={
            overlay.sourcePickerOpen
              ? 'small-secondary-btn no-drag active'
              : 'small-secondary-btn no-drag'
          }
          disabled={!controls || controls.sourcePicker.disabled}
          aria-expanded={overlay.sourcePickerOpen}
          title={controls?.sourcePicker.title ?? 'Select window or display'}
          onClick={() => void window.elmDesktop.toggleHostSourcePickerPopup()}
        >
          Source ▾
        </button>

        {/* Chat Popup */}
        <button
          type="button"
          data-testid="floating-chat-toggle"
          className={
            overlay.chatOpen
              ? 'small-secondary-btn no-drag active'
              : 'small-secondary-btn no-drag'
          }
          title="Open or close independent private Chat popup"
          onClick={() => {
            if (overlay.chatOpen) {
              void window.elmDesktop.closeSeparateChatWindow();
            } else {
              void window.elmDesktop.openSeparateChatWindow();
            }
          }}
        >
          Chat
        </button>

        {/* Settings Popup */}
        <button
          type="button"
          data-testid="floating-settings-toggle"
          className={
            overlay.settingsOpen
              ? 'small-secondary-btn no-drag active'
              : 'small-secondary-btn no-drag'
          }
          aria-expanded={overlay.settingsOpen}
          title="Appearance settings"
          onClick={() => void window.elmDesktop.toggleHostSettingsPopup()}
        >
          Settings
        </button>

        <span className="floating-toolbar-divider" aria-hidden="true" />

        {/* End Session */}
        <button
          type="button"
          data-testid="floating-end-session"
          className="danger-btn no-drag"
          title="End approved session for both participants"
          onClick={() =>
            void window.elmDesktop.dispatchHostToolbarAction({
              type: 'end-session',
            })
          }
        >
          End Session
        </button>
      </div>
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
      className="overlay-popup-shell"
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
      className="overlay-popup-shell floating-settings-sidebar"
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

        <label className="sidebar-slider">
          <span>Toolbar Font Size: {appearance.barTextSizePx}px</span>
          <input
            type="range"
            data-testid="settings-toolbar-fontsize-slider"
            min={11}
            max={16}
            step={1}
            value={appearance.barTextSizePx}
            onChange={(e) =>
              updateAppearance({ barTextSizePx: Number(e.target.value) })
            }
          />
        </label>

        <label className="sidebar-slider">
          <span>Chat Font Size: {appearance.chatTextSizePx}px</span>
          <input
            type="range"
            data-testid="settings-chat-fontsize-slider"
            min={12}
            max={18}
            step={1}
            value={appearance.chatTextSizePx}
            onChange={(e) =>
              updateAppearance({ chatTextSizePx: Number(e.target.value) })
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
      className="chat-popup-shell"
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
            title="Close Chat popup without ending session"
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
              onClick={() => fileInputRef.current?.click()}
              title="Attach an image in memory for this session only"
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
