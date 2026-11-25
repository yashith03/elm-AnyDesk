import React, { useEffect, useRef, useState } from 'react';
import {
  INVITE_TIMEOUT_MS,
  type AccountProfile,
  type HostMediaSelection,
  type InviteIntent,
  type InviteSummary,
  type PresenceStateSnapshot,
} from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  DeviceSetupState,
  HostOverlayUiState,
  PresenceRuntimeStatus,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  VolatileSessionUiState,
} from '../shared/bridge';
import {
  HostFloatingToolbarWindow,
  HostSettingsPopup,
  HostSourcePickerPopup,
  PrivateChatPopupWindow,
} from './HostOverlayWindows';
import type { ThemeMode, ThemeStateSnapshot } from '../shared/theme';
import {
  MAX_CHAT_IMAGE_BYTES,
  SUPPORTED_CHAT_IMAGE_MIME_TYPES,
  validateChatImageAttachment,
} from '../shared/chat-attachments';
import { formatIncomingRequestHeadline } from '../shared/incoming-request';
import {
  buildOutgoingPeerContactCard,
  resolveRecentPeerDisplayName,
  type PeerOnlineStatus,
  type RecentPeerEntry,
} from '../shared/recent-peers';
import {
  formatCountdownMmSs,
  resolveWaitingPeerName,
} from '../shared/request-ui';
import {
  computeUnreadChatState,
  getChatStatusDisplay,
  getSessionStageStatus,
  getTransportStatusDisplay,
} from '../shared/session-ui-status';
import {
  buildBackgroundRgba,
  clampFloatingPanelLayout,
  DEFAULT_FLOATING_PANEL_APPEARANCE,
  DEFAULT_FLOATING_PANEL_LAYOUT,
  sanitizeFloatingPanelAppearance,
  type FloatingPanelAppearance,
  type FloatingPanelLayout,
} from '../shared/floating-panel';
import {
  shouldDismissOnKeyDown,
  shouldDismissOnOutsidePointerDown,
} from '../shared/toolbar-media';
import {
  ApprovedWebRtcSessionController,
  runAllWebRtcSessionVerificationMatrix,
  runPhase4LifecycleAndTeardownVerificationSuite,
  type Phase4VerificationSuiteReport,
  type SessionCombinationVerificationReport,
  type WebRtcReadabilityDiagnostics,
  type WebRtcSessionSnapshot,
} from './webrtc-session';

function isValidPresenceSnapshot(
  candidate: unknown
): candidate is PresenceStateSnapshot {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const snap = candidate as Partial<PresenceStateSnapshot>;
  return (
    typeof snap.online === 'boolean' &&
    Boolean(snap.account && typeof snap.account === 'object') &&
    Array.isArray(snap.incomingInvites)
  );
}

function ThemeToggleButton(props: {
  themeState: ThemeStateSnapshot;
  onToggle: () => void;
  suppressTooltip?: boolean;
}): React.ReactElement {
  const isDark = props.themeState.mode === 'dark';
  return (
    <button
      type="button"
      data-testid="theme-toggle-button"
      className="theme-toggle-btn no-drag"
      aria-label={`Switch to ${isDark ? 'Light' : 'Dark'} theme (current: ${
        isDark ? 'Dark' : 'Light'
      })`}
      aria-pressed={isDark}
      title={
        props.suppressTooltip
          ? undefined
          : `Current theme: ${isDark ? 'Dark' : 'Light'} (${
              props.themeState.source === 'system_default'
                ? 'System Default'
                : 'Saved Preference'
            }). Click or press Enter/Space to switch.`
      }
      onClick={props.onToggle}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {isDark ? (
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="square"
            strokeLinejoin="miter"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="square"
            strokeLinejoin="miter"
          >
            <circle cx="12" cy="12" r="4" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="4.93" y1="4.93" x2="7.05" y2="7.05" />
            <line x1="16.95" y1="16.95" x2="19.07" y2="19.07" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
            <line x1="4.93" y1="19.07" x2="7.05" y2="16.95" />
            <line x1="16.95" y1="7.05" x2="19.07" y2="4.93" />
          </svg>
        )}
      </span>
      <span>{isDark ? 'Dark' : 'Light'}</span>
    </button>
  );
}

export function App(): React.ReactElement {
  const [metadata, setMetadata] = useState<DesktopRuntimeMetadata | null>(null);
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const [snapshot, setSnapshot] = useState<PresenceStateSnapshot | null>(null);
  const [presenceRuntime, setPresenceRuntime] = useState<PresenceRuntimeStatus>({
    connectionState: 'connecting',
    serverConfirmedOnline: false,
    lastConfirmedAt: null,
    consecutiveFailures: 0,
    snapshot: null,
  });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Copy Friend Code feedback & transient bottom-center toast
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [toastState, setToastState] = useState<{
    message: string;
    variant: 'info' | 'error';
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // Home Connection Input & Request Modals
  const [enteredFriendCode, setEnteredFriendCode] = useState<string>('');
  const [inviteDialogOpen, setInviteDialogOpen] = useState<boolean>(false);
  const [inviteTargetCode, setInviteTargetCode] = useState<string>('');
  const [inviteHostMedia, setInviteHostMedia] = useState<HostMediaSelection>({
    screenVideo: true,
    microphoneAudio: false,
    deviceAudio: false,
  });
  const [requestOutcomeModal, setRequestOutcomeModal] = useState<{
    kind: 'offline' | 'expired';
    friendCode: string;
    intent: InviteIntent;
    hostMediaSelection?: HostMediaSelection;
    inviteId?: string;
  } | null>(null);

  // Settings Modal Draft State & Focus Management
  const [settingsDraftName, setSettingsDraftName] = useState<string>('');
  const [settingsDraftEmail, setSettingsDraftEmail] = useState<string>('');
  const [settingsDraftPhone, setSettingsDraftPhone] = useState<string>('');
  const [settingsDraftTheme, setSettingsDraftTheme] = useState<ThemeMode>('dark');
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsModalRef = useRef<HTMLDivElement | null>(null);

  // Pre-Accept Media Controls chosen independently by User A (Both audio options default OFF)
  const [preAcceptMedia, setPreAcceptMedia] = useState<HostMediaSelection>({
    screenVideo: false,
    microphoneAudio: false,
    deviceAudio: false,
  });

  // Shareable Windows & Displays for Host A
  const [shareableSources, setShareableSources] = useState<
    ShareableSourceDescriptor[]
  >([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [isStartingShare, setIsStartingShare] = useState<boolean>(false);
  const [isStartingMic, setIsStartingMic] = useState<boolean>(false);
  const [isStartingDeviceSound, setIsStartingDeviceSound] =
    useState<boolean>(false);
  const [playWasapiTestTone] = useState<boolean>(false);
  const [hostOverlayState, setHostOverlayState] =
    useState<HostOverlayUiState | null>(null);
  const [hostSourcePickerOpen, setHostSourcePickerOpen] =
    useState<boolean>(false);
  const hostSourcePopoverRef = useRef<HTMLDivElement | null>(null);
  const hostSourceToggleRef = useRef<HTMLButtonElement | null>(null);
  const floatingSettingsSidebarRef = useRef<HTMLElement | null>(null);
  const floatingSettingsToggleRef = useRef<HTMLButtonElement | null>(null);

  // On-device first-launch profile & anonymous device registration state
  const [deviceSetupState, setDeviceSetupState] =
    useState<DeviceSetupState | null>(null);
  const [setupNameInput, setSetupNameInput] = useState<string>('');
  const [setupEmailInput, setSetupEmailInput] = useState<string>('');
  const [setupPhoneInput, setSetupPhoneInput] = useState<string>('');
  const [savingProfile, setSavingProfile] = useState<boolean>(false);
  const [retryingRegistration, setRetryingRegistration] =
    useState<boolean>(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState<boolean>(false);

  // On-device in-memory-only session chat/image drafts
  const [pendingImageDataUrl, setPendingImageDataUrl] = useState<string | null>(
    null
  );
  const [pendingImageName, setPendingImageName] = useState<string | null>(null);
  const [pendingImageMimeType, setPendingImageMimeType] = useState<
    string | null
  >(null);
  const [pendingImageByteLength, setPendingImageByteLength] =
    useState<number>(0);
  const [chatAttachmentError, setChatAttachmentError] = useState<string | null>(
    null
  );
  const [inMemoryImagesByMsgId, setInMemoryImagesByMsgId] = useState<
    Record<string, string>
  >({});
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);

  // WebRTC Session State (Main Window)
  const webrtcControllerRef = useRef<ApprovedWebRtcSessionController | null>(
    null
  );
  const [webrtcSnap, setWebrtcSnap] = useState<WebRtcSessionSnapshot | null>(
    null
  );

  // Separate Chat Window State (role === 'chat')
  const [volatileChatState, setVolatileChatState] =
    useState<VolatileSessionUiState | null>(null);
  const [chatInputText, setChatInputText] = useState<string>('');

  // Guest B media element refs for local playback (and Host A playback of Viewer mic)
  const guestVideoRef = useRef<HTMLVideoElement | null>(null);
  const guestMicAudioRef = useRef<HTMLAudioElement | null>(null);
  const guestDeviceAudioRef = useRef<HTMLAudioElement | null>(null);
  const hostViewerMicAudioRef = useRef<HTMLAudioElement | null>(null);

  // Viewer Display Mode, DPI Scaling & Readability Diagnostics State
  const [viewerMode, setViewerMode] = useState<'fit' | 'actual'>('fit');
  const [optInDiagnostics, setOptInDiagnostics] = useState<boolean>(false);
  const [liveDiagnostics, setLiveDiagnostics] =
    useState<WebRtcReadabilityDiagnostics | null>(null);
  const [renderedDimensions, setRenderedDimensions] = useState<{
    clientWidth: number;
    clientHeight: number;
    videoWidth: number;
    videoHeight: number;
    dpr: number;
  } | null>(null);
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerViewportRef = useRef<HTMLDivElement | null>(null);
  const presentationVideoRef = useRef<HTMLVideoElement | null>(null);

  // One Floating Panel over Active Viewer
  const [floatingChatOpen, setFloatingChatOpen] = useState<boolean>(false);
  const [floatingSettingsOpen, setFloatingSettingsOpen] =
    useState<boolean>(false);
  const [hasUnreadChat, setHasUnreadChat] = useState<boolean>(false);
  const [isDocumentHidden, setIsDocumentHidden] = useState<boolean>(
    () => typeof document !== 'undefined' && document.visibilityState !== 'visible'
  );
  const readIncomingMessageIdsRef = useRef<Set<string>>(new Set());
  const viewerChatScrollRef = useRef<HTMLDivElement | null>(null);

  // Window Controls & Request Lifecycle State
  const [isWindowMaximized, setIsWindowMaximized] = useState<boolean>(false);
  const [recentViewMode, setRecentViewMode] = useState<'grid' | 'list'>('grid');
  const [submittingRequest, setSubmittingRequest] = useState<boolean>(false);
  const [cancellingInviteId, setCancellingInviteId] = useState<string | null>(
    null
  );
  const [dismissedExpiredInviteIds, setDismissedExpiredInviteIds] = useState<
    Record<string, true>
  >({});
  const [nowTickMs, setNowTickMs] = useState<number>(() => Date.now());
  const snapshotEpochRef = useRef<number>(0);
  const lastAppliedSnapshotGenRef = useRef<number>(0);

  // External Invitation Copy Feedback
  const [copiedInvitation, setCopiedInvitation] = useState<boolean>(false);

  // Unified Recent Sessions + Favorites + Server Presence Dots
  const [recentPeers, setRecentPeers] = useState<RecentPeerEntry[]>([]);
  const [peerOnlineMap, setPeerOnlineMap] = useState<
    Record<string, PeerOnlineStatus>
  >({});
  const [openPeerMenuCode, setOpenPeerMenuCode] = useState<string | null>(null);
  const [renamingPeerCode, setRenamingPeerCode] = useState<string | null>(null);
  const [renameAliasInput, setRenameAliasInput] = useState<string>('');
  const [panelAppearance, setPanelAppearance] =
    useState<FloatingPanelAppearance>(() => {
      try {
        const raw = localStorage.getItem('elm-floating-panel-appearance');
        if (raw) {
          return sanitizeFloatingPanelAppearance(
            JSON.parse(raw) as Partial<FloatingPanelAppearance>
          );
        }
      } catch {
        // Ignore storage errors
      }
      return DEFAULT_FLOATING_PANEL_APPEARANCE;
    });
  const [panelLayout, setPanelLayout] = useState<FloatingPanelLayout>(
    DEFAULT_FLOATING_PANEL_LAYOUT
  );
  const panelInteractionRef = useRef<{
    kind: 'drag' | 'resize-width' | 'resize-both';
    startX: number;
    startY: number;
    initial: FloatingPanelLayout;
  } | null>(null);

  // 5-Combination Verification Matrix state
  const [matrixReport, setMatrixReport] = useState<Record<
    string,
    SessionCombinationVerificationReport
  > | null>(null);
  const [runningMatrix, setRunningMatrix] = useState<boolean>(false);

  // Phase 4 Teardown & Liveness Verification Matrix state
  const [phase4Report, setPhase4Report] =
    useState<Phase4VerificationSuiteReport | null>(null);
  const [runningPhase4, setRunningPhase4] = useState<boolean>(false);

  const clearGuestMediaElements = () => {
    if (guestVideoRef.current) {
      guestVideoRef.current.srcObject = null;
    }
    if (guestMicAudioRef.current) {
      guestMicAudioRef.current.srcObject = null;
    }
    if (guestDeviceAudioRef.current) {
      guestDeviceAudioRef.current.srcObject = null;
    }
    setChatInputText('');
    setPendingImageDataUrl(null);
    setPendingImageName(null);
    setPendingImageMimeType(null);
    setPendingImageByteLength(0);
    setChatAttachmentError(null);
    setInMemoryImagesByMsgId({});
    setSelectedSourceId(null);
    setIsStartingShare(false);
  };

  // Prototype drawer state
  const [showPrototypeDrawer, setShowPrototypeDrawer] =
    useState<boolean>(false);
  const [dwmTelemetry, setDwmTelemetry] = useState<TaskbarDwmTelemetry | null>(
    null
  );

  // Shared Light/Dark Theme State (synced across Main Window & Separate Chat Window)
  const [themeState, setThemeState] = useState<ThemeStateSnapshot>({
    mode: 'dark',
    source: 'system_default',
    systemPrefersDark: true,
    updatedAt: new Date().toISOString(),
  });

  const applyThemeToDom = (mode: ThemeMode) => {
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.style.colorScheme = mode;
  };

  useEffect(() => {
    applyThemeToDom(themeState.mode);
  }, [themeState.mode]);

  useEffect(() => {
    let mounted = true;

    // Resolve fast local state immediately so the shell renders without waiting on network calls.
    Promise.all([
      window.elmDesktop.getRuntimeMetadata(),
      window.elmDesktop.getVolatileSessionUiState(),
      window.elmDesktop.getHostOverlayState().catch(() => null),
      window.elmDesktop.getFloatingAppearance().catch(() => null),
      window.elmDesktop.getTaskbarDwmTelemetry().catch(() => null),
      window.elmDesktop.getThemeState().catch(() => null),
      window.elmDesktop.getRecentPeers().catch(() => [] as RecentPeerEntry[]),
      window.elmDesktop.isWindowMaximized().catch(() => false),
    ])
      .then(
        ([
          meta,
          volatileState,
          overlayState,
          floatingApp,
          dwm,
          initialTheme,
          peers,
          maximized,
        ]) => {
          if (!mounted) return;
          setMetadata(meta);
          const isOverlayRole =
            meta.windowRole === 'host-toolbar' ||
            meta.windowRole === 'host-source-picker' ||
            meta.windowRole === 'host-settings' ||
            meta.windowRole === 'chat';
          if (isOverlayRole) {
            document.documentElement.dataset.overlayWindow = 'true';
          } else {
            delete document.documentElement.dataset.overlayWindow;
          }
          setVolatileChatState(volatileState);
          if (overlayState) setHostOverlayState(overlayState);
          if (floatingApp) {
            setPanelAppearance(sanitizeFloatingPanelAppearance(floatingApp));
          }
          setRecentPeers(Array.isArray(peers) ? peers : []);
          setIsWindowMaximized(Boolean(maximized));
          if (dwm) setDwmTelemetry(dwm);
          if (initialTheme) {
            setThemeState(initialTheme);
            applyThemeToDom(initialTheme.mode);
          }

          if (meta.windowRole === 'main') {
            (async () => {
              try {
                const setupRes = await window.elmDesktop.getDeviceSetupState();
                if (!mounted) return;
                if (setupRes.ok && setupRes.data) {
                  setDeviceSetupState(setupRes.data);
                  if (setupRes.data.localProfile) {
                    setSetupNameInput(setupRes.data.localProfile.name);
                    setSetupEmailInput(setupRes.data.localProfile.email);
                    setSetupPhoneInput(setupRes.data.localProfile.phone);
                  }
                  if (setupRes.data.registeredAccount) {
                    setAccount(setupRes.data.registeredAccount);
                  }
                }
                const [storedRes, runtimeRes] = await Promise.all([
                  window.elmDesktop.getStoredAuthSession(),
                  window.elmDesktop.getPresenceRuntimeStatus(),
                ]);
                if (!mounted) return;
                setPresenceRuntime(runtimeRes);
                if (storedRes.ok && storedRes.data) {
                  setAccount(storedRes.data.account);
                  setSnapshot(storedRes.data.snapshot);
                } else if (runtimeRes.snapshot) {
                  setSnapshot(runtimeRes.snapshot);
                }
              } catch (err: unknown) {
                if (mounted) {
                  setErrorMessage(
                    err instanceof Error ? err.message : String(err)
                  );
                }
              }
            })();
          }
        }
      )
      .catch((err: unknown) => {
        if (mounted) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      });

    const unsubPresence = window.elmDesktop.onPresenceStatusUpdated(
      (nextRuntime) => {
        if (!mounted) return;
        setPresenceRuntime(nextRuntime);
        const candidate = nextRuntime.snapshot;
        if (!isValidPresenceSnapshot(candidate)) {
          return;
        }
        const incomingGen = nextRuntime.snapshotGeneration ?? 0;
        if (incomingGen > 0 && incomingGen < lastAppliedSnapshotGenRef.current) {
          return;
        }
        const isNewerMutation =
          incomingGen > 0 && incomingGen > lastAppliedSnapshotGenRef.current;
        if (nextRuntime.connectionState !== 'online' && !isNewerMutation) {
          return;
        }
        if (incomingGen > 0) {
          lastAppliedSnapshotGenRef.current = incomingGen;
        }
        setSnapshot((prev) => {
          if (
            nextRuntime.connectionState !== 'online' &&
            prev?.activeSession &&
            !candidate.activeSession &&
            !isNewerMutation
          ) {
            return { ...candidate, activeSession: prev.activeSession };
          }
          return candidate;
        });
      }
    );

    const handleNetworkChange = () => {
      void window.elmDesktop.triggerPresenceReconnect();
    };
    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);

    const unsubVolatile = window.elmDesktop.onVolatileSessionUiStateUpdated(
      (nextState) => {
        if (mounted) {
          setVolatileChatState(nextState);
        }
      }
    );

    const unsubOverlay = window.elmDesktop.onHostOverlayStateUpdated(
      (nextOverlay) => {
        if (mounted) {
          setHostOverlayState(nextOverlay);
          setPanelAppearance(
            sanitizeFloatingPanelAppearance(nextOverlay.appearance)
          );
        }
      }
    );

    const unsubAppearance = window.elmDesktop.onFloatingAppearanceUpdated(
      (nextApp) => {
        if (mounted) {
          setPanelAppearance(sanitizeFloatingPanelAppearance(nextApp));
        }
      }
    );

    const unsubTheme = window.elmDesktop.onThemeUpdated((nextTheme) => {
      if (mounted) {
        setThemeState(nextTheme);
        applyThemeToDom(nextTheme.mode);
      }
    });

    const unsubMaximized = window.elmDesktop.onWindowMaximizedChanged(
      (maximized) => {
        if (mounted) {
          setIsWindowMaximized(maximized);
        }
      }
    );

    return () => {
      mounted = false;
      unsubPresence();
      window.removeEventListener('online', handleNetworkChange);
      window.removeEventListener('offline', handleNetworkChange);
      unsubVolatile();
      unsubOverlay();
      unsubAppearance();
      unsubTheme();
      unsubMaximized();
    };
  }, []);

  const handleToggleTheme = async () => {
    const nextMode: ThemeMode = themeState.mode === 'dark' ? 'light' : 'dark';
    applyThemeToDom(nextMode);
    const updated = await window.elmDesktop.setThemeMode(nextMode);
    setThemeState(updated);
    applyThemeToDom(updated.mode);
  };

  const applyAuthoritativeSnapshot = (
    nextSnapshot: PresenceStateSnapshot | null | undefined
  ) => {
    if (!isValidPresenceSnapshot(nextSnapshot)) {
      return;
    }
    snapshotEpochRef.current += 1;
    setSnapshot(nextSnapshot);
  };

  // Background remote invite/session state polling while server-confirmed online
  // (offline/reconnecting backoff is driven by the main-process presence heartbeat loop)
  useEffect(() => {
    if (
      !metadata ||
      metadata.windowRole !== 'main' ||
      !account ||
      account.provider === 'test-double' ||
      presenceRuntime.connectionState !== 'online'
    ) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const epoch = snapshotEpochRef.current;
      const res = await window.elmDesktop.getPresenceSnapshot();
      if (
        !cancelled &&
        epoch === snapshotEpochRef.current &&
        res.ok &&
        res.data &&
        isValidPresenceSnapshot(res.data.snapshot)
      ) {
        setSnapshot(res.data.snapshot);
      }
    };

    const timer = setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    metadata?.windowRole,
    account?.accountId,
    account?.provider,
    presenceRuntime.connectionState,
  ]);

  // Countdown & expiry check for outgoing connection request
  const pendingOutgoingId = snapshot?.outgoingInvite?.inviteId ?? null;
  const pendingOutgoingExpiresAt = snapshot?.outgoingInvite?.expiresAt ?? null;
  useEffect(() => {
    if (!pendingOutgoingId || !pendingOutgoingExpiresAt) return;
    setNowTickMs(Date.now());
    const timer = setInterval(() => {
      const now = Date.now();
      setNowTickMs(now);
      if (now >= Date.parse(pendingOutgoingExpiresAt)) {
        const epoch = snapshotEpochRef.current;
        void window.elmDesktop.getPresenceSnapshot().then((res) => {
          if (
            epoch === snapshotEpochRef.current &&
            res.ok &&
            res.data &&
            isValidPresenceSnapshot(res.data.snapshot)
          ) {
            setSnapshot(res.data.snapshot);
          }
        });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [pendingOutgoingId, pendingOutgoingExpiresAt]);

  // Surface Request Expired dialog when server marks latest outgoing invite expired
  const expiredOutgoingInvite = snapshot?.recentExpiredOutgoingInvite ?? null;
  useEffect(() => {
    if (!expiredOutgoingInvite) return;
    if (dismissedExpiredInviteIds[expiredOutgoingInvite.inviteId]) return;
    setRequestOutcomeModal((prev) => {
      if (prev?.inviteId === expiredOutgoingInvite.inviteId) return prev;
      return {
        kind: 'expired',
        friendCode: expiredOutgoingInvite.targetFriendCode,
        intent: expiredOutgoingInvite.intent,
        hostMediaSelection: expiredOutgoingInvite.hostMediaSelection,
        inviteId: expiredOutgoingInvite.inviteId,
      };
    });
  }, [expiredOutgoingInvite?.inviteId, dismissedExpiredInviteIds]);

  // Poll server-confirmed online status for Recent Sessions cards while Home screen is visible
  const recentPeerCodesKey = recentPeers.map((p) => p.friendCode).join(',');
  const isHomeScreenVisible = !snapshot?.activeSession;
  useEffect(() => {
    if (
      !metadata ||
      metadata.windowRole !== 'main' ||
      !account ||
      recentPeers.length === 0
    ) {
      return;
    }

    const codes = recentPeers.map((p) => p.friendCode);
    const setAllUnknown = () => {
      const unknown: Record<string, PeerOnlineStatus> = {};
      for (const c of codes) {
        unknown[c] = 'unknown';
      }
      setPeerOnlineMap(unknown);
    };

    // Never retain stale green dots when local device is not confirmed online
    if (presenceRuntime.connectionState !== 'online') {
      setAllUnknown();
      return;
    }

    if (!isHomeScreenVisible) {
      return;
    }

    let cancelled = false;
    const refreshPeerPresence = async () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      const res = await window.elmDesktop.lookupDevicePresence(codes);
      if (cancelled) return;
      if (res.ok && res.data) {
        const next: Record<string, PeerOnlineStatus> = {};
        for (const c of codes) {
          next[c] = res.data.statuses[c] ? 'online' : 'offline';
        }
        setPeerOnlineMap(next);
      } else {
        setAllUnknown();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshPeerPresence();
      }
    };

    void refreshPeerPresence();
    const timer = setInterval(() => {
      void refreshPeerPresence();
    }, 7000);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    metadata?.windowRole,
    account?.accountId,
    recentPeerCodesKey,
    isHomeScreenVisible,
    presenceRuntime.connectionState,
  ]);

  // Manage ApprovedWebRtcSessionController lifecycle in Main Window when an approved session starts/ends
  const activeSessionId = snapshot?.activeSession?.sessionId ?? null;
  useEffect(() => {
    if (!metadata || metadata.windowRole !== 'main') return;

    const currentSession = snapshot?.activeSession ?? null;
    if (!currentSession) {
      if (webrtcControllerRef.current) {
        const prevSnap = webrtcControllerRef.current.getSnapshot();
        const prevReceipt = prevSnap.teardownReceipt;
        if (
          prevReceipt &&
          prevReceipt.reason !== 'user_top_bar_disconnect' &&
          prevSnap.lastStatusBanner
        ) {
          setStatusMessage(prevSnap.lastStatusBanner);
        }
        webrtcControllerRef.current.destroyLocalOnly(
          'connection_lost',
          'session_cleared_by_server',
          { silent: true }
        );
        webrtcControllerRef.current = null;
      }
      clearGuestMediaElements();
      setFloatingChatOpen(false);
      setFloatingSettingsOpen(false);
      setHostSourcePickerOpen(false);
      setWebrtcSnap(null);
      void window.elmDesktop.syncVolatileSessionUiState({
        session: null,
        currentAccount: account,
        connectionState: 'closed',
        dataChannelState: 'closed',
        messages: [],
        imageAttachmentsByMessageId: {},
        messageStatusesById: {},
        hostMediaState: null,
      });
      return;
    }

    if (
      webrtcControllerRef.current &&
      webrtcControllerRef.current.session.sessionId === currentSession.sessionId
    ) {
      return;
    }

    if (webrtcControllerRef.current) {
      webrtcControllerRef.current.destroyLocalOnly(
        'connection_lost',
        'session_replaced',
        { silent: true }
      );
      webrtcControllerRef.current = null;
    }

    const isRemoteSession = account?.provider !== 'test-double';
    const localRole: 'host' | 'guest' =
      account?.accountId === currentSession.guestAccountId ? 'guest' : 'host';

    const peerCode =
      localRole === 'host'
        ? currentSession.guestFriendCode
        : currentSession.hostFriendCode;
    const rawPeerName =
      localRole === 'host'
        ? currentSession.guestDisplayName
        : currentSession.hostDisplayName;
    const isGenericPeerName =
      !rawPeerName ||
      ['elm device', 'windows desktop', 'unknown device'].includes(
        rawPeerName.trim().toLowerCase()
      );
    setRequestOutcomeModal(null);
    setInviteDialogOpen(false);
    setShowSettingsPanel(false);
    void window.elmDesktop
      .recordConnectedPeer({
        friendCode: peerCode,
        defaultAlias: isGenericPeerName ? undefined : rawPeerName,
        connectedAt: currentSession.createdAt,
      })
      .then(setRecentPeers);

    const localContactCard = buildOutgoingPeerContactCard(
      deviceSetupState?.localProfile ??
        (account
          ? {
              name: account.displayName,
              email: '',
              phone: '',
              shareEmailWithPeers: false,
              sharePhoneWithPeers: false,
              updatedAt: '',
            }
          : null)
    );

    const controller = new ApprovedWebRtcSessionController(
      currentSession,
      (nextSnap) => {
        if (webrtcControllerRef.current !== controller) {
          return;
        }
        setWebrtcSnap(nextSnap);
        void window.elmDesktop.syncVolatileSessionUiState({
          session: nextSnap.teardownReceipt ? null : currentSession,
          currentAccount: account,
          connectionState: nextSnap.connectionState,
          dataChannelState: nextSnap.dataChannelState,
          messages: nextSnap.messages,
          imageAttachmentsByMessageId: nextSnap.teardownReceipt
            ? {}
            : nextSnap.imageAttachmentsByMessageId,
          messageStatusesById: nextSnap.teardownReceipt
            ? {}
            : nextSnap.messageStatusesById,
          hostMediaState: nextSnap.hostMediaState,
        });
      },
      {
        mode: isRemoteSession ? 'remote' : 'loopback',
        localRole,
        onGuestViewerCleared: clearGuestMediaElements,
        localContactCard,
        onPeerContactReceived: (contact) => {
          void window.elmDesktop
            .updateRecentPeerContact({
              friendCode: peerCode,
              peerName: contact.name,
              email: contact.email,
              phone: contact.phone,
              connectedAt: currentSession.createdAt,
            })
            .then(setRecentPeers);
        },
        onSessionEndedRemotely: ({ sessionId, message }) => {
          if (webrtcControllerRef.current === controller) {
            webrtcControllerRef.current = null;
          }
          clearGuestMediaElements();
          setFloatingChatOpen(false);
          setFloatingSettingsOpen(false);
          setHostSourcePickerOpen(false);
          setWebrtcSnap(null);
          setSnapshot((prev) =>
            prev && prev.activeSession?.sessionId === sessionId
              ? { ...prev, activeSession: null }
              : prev
          );
          setStatusMessage(message);
          void window.elmDesktop.syncVolatileSessionUiState({
            session: null,
            currentAccount: account,
            connectionState: 'closed',
            dataChannelState: 'closed',
            messages: [],
            hostMediaState: null,
          });
          void window.elmDesktop.getPresenceSnapshot().then((fresh) => {
            if (fresh.ok && fresh.data?.snapshot) {
              applyAuthoritativeSnapshot(fresh.data.snapshot);
            }
          });
        },
      }
    );

    webrtcControllerRef.current = controller;
    (
      window as unknown as {
        __elmGetLiveWebRtcProbe?: () => Promise<Record<string, unknown> | null>;
      }
    ).__elmGetLiveWebRtcProbe = async () => {
      const ctrl = webrtcControllerRef.current;
      if (!ctrl) return null;
      const snap = ctrl.getSnapshot();
      const diag = await ctrl.sampleReadabilityDiagnostics();
      return {
        sessionId: snap.sessionId,
        localRole,
        connectionState: snap.connectionState,
        iceConnectionState: snap.iceConnectionState,
        dataChannelState: snap.dataChannelState,
        sharingStartedByHost: snap.sharingStartedByHost,
        hostMicMutedLocally: snap.hostMicMutedLocally,
        hostMediaState: snap.hostMediaState,
        guestPlayback: snap.guestPlayback,
        guestReceivedTrackSources: snap.guestReceivedTracks.map((t) => t.source),
        guestVideoTracksCount: snap.guestVideoTracksCount,
        guestAudioTracksCount: snap.guestAudioTracksCount,
        messagesCount: snap.messages.length,
        imageAttachmentsCount: Object.keys(snap.imageAttachmentsByMessageId).length,
        diagnostics: diag,
      };
    };

    // Automatically load shareable sources so Host A can pick one before clicking Start Sharing
    void window.elmDesktop.listShareableSources().then((sources) => {
      setShareableSources(sources);
      setSelectedSourceId((prev) => {
        if (sources.length === 0) return null;
        if (prev && sources.some((s) => s.id === prev)) return prev;
        return sources[0].id;
      });
    });

    // Connect WebRTC PeerConnection & reliable DataChannel immediately upon acceptance
    // (Zero media tracks are captured or attached before Host A explicitly clicks Start Sharing)
    void controller.connectAcceptedSession();

    return () => {
      // Local-only cleanup on React unmount/re-run; never invoke POST /sessions/disconnect here.
      if (webrtcControllerRef.current === controller) {
        const snap = controller.getSnapshot();
        if (
          snap.teardownReceipt &&
          snap.teardownReceipt.reason !== 'user_top_bar_disconnect' &&
          snap.lastStatusBanner
        ) {
          setStatusMessage(snap.lastStatusBanner);
        }
        controller.destroyLocalOnly('app_closed', 'react_unmount', {
          silent: true,
        });
        webrtcControllerRef.current = null;
      }
    };
  }, [activeSessionId, metadata?.windowRole]);

  // Listen in Main Window for chat outbound sends and Stop Sharing commands from the Separate Chat Window
  useEffect(() => {
    if (!metadata || metadata.windowRole !== 'main') return;

    const unsubChatSend = window.elmDesktop.onChatWindowOutboundSend(
      async ({
        text,
        senderOverride,
        imageDataUrl,
        imageMimeType,
        imageByteLength,
      }) => {
        const ctrl = webrtcControllerRef.current;
        if (!ctrl) return;
        const defaultRole =
          account?.accountId === ctrl.session.guestAccountId ? 'guest' : 'host';
        const activeSender = senderOverride ?? defaultRole;
        const localProfileName =
          deviceSetupState?.localProfile?.name?.trim() ||
          account?.displayName?.trim() ||
          undefined;
        ctrl.setLocalDisplayName(localProfileName);
        if (imageDataUrl && imageMimeType) {
          ctrl.sendChatImageOverDataChannel({
            sender: activeSender,
            senderAccountId:
              account?.accountId ??
              (activeSender === 'host'
                ? ctrl.session.hostAccountId
                : ctrl.session.guestAccountId),
            senderDisplayName:
              localProfileName ??
              (activeSender === 'host'
                ? ctrl.session.hostDisplayName
                : ctrl.session.guestDisplayName),
            text,
            mimeType: imageMimeType,
            byteLength: imageByteLength ?? 0,
            dataUrl: imageDataUrl,
          });
          return;
        }
        await ctrl.sendChatMessageOverDataChannel({
          sender: activeSender,
          text,
          senderDisplayName: localProfileName,
        });
      }
    );

    const unsubStopReq = window.elmDesktop.onHostStopSharingRequest(
      async (target) => {
        const ctrl = webrtcControllerRef.current;
        if (!ctrl) return;
        if (target === 'all') {
          await ctrl.stopAllHostSharing();
        } else {
          await ctrl.stopHostSource(target);
        }
      }
    );

    return () => {
      unsubChatSend();
      unsubStopReq();
    };
  }, [
    metadata?.windowRole,
    account?.accountId,
    account?.displayName,
    deviceSetupState?.localProfile?.name,
  ]);

  useEffect(() => {
    if (metadata?.windowRole !== 'main') return;
    return window.elmDesktop.onChatMessagesSeenRequested((messageIds) => {
      webrtcControllerRef.current?.markMessagesSeen(messageIds);
    });
  }, [metadata?.windowRole]);

  useEffect(() => {
    const ctrl = webrtcControllerRef.current;
    if (!ctrl) return;
    const localProfileName =
      deviceSetupState?.localProfile?.name?.trim() ||
      account?.displayName?.trim() ||
      undefined;
    ctrl.setLocalDisplayName(localProfileName);
  }, [deviceSetupState?.localProfile?.name, account?.displayName, activeSessionId]);

  useEffect(() => {
    if (metadata?.windowRole !== 'main') return;
    if (!floatingChatOpen || isDocumentHidden || !activeSessionId) return;
    const container = viewerChatScrollRef.current;
    const ctrl = webrtcControllerRef.current;
    if (!container || !ctrl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleIds: string[] = [];
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = (entry.target as HTMLElement).dataset.messageId;
            if (id) visibleIds.push(id);
          }
        }
        if (visibleIds.length > 0 && document.visibilityState === 'visible') {
          ctrl.markMessagesSeen(visibleIds);
        }
      },
      { root: container, threshold: 0.25 }
    );

    const nodes = container.querySelectorAll('[data-message-id][data-incoming="true"]');
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [
    metadata?.windowRole,
    floatingChatOpen,
    isDocumentHidden,
    activeSessionId,
    webrtcSnap?.messages.length,
  ]);

  // Bind Guest B's received tracks to Guest B's local <video> and <audio> playback elements
  useEffect(() => {
    if (!webrtcSnap) return;

    const videoTrackInfo = webrtcSnap.guestReceivedTracks.find(
      (t) => t.source === 'screenVideo' && t.kind === 'video'
    );
    if (guestVideoRef.current) {
      if (videoTrackInfo && !webrtcSnap.guestPlayback.videoPausedLocally) {
        if (guestVideoRef.current.srcObject !== videoTrackInfo.stream) {
          guestVideoRef.current.srcObject = videoTrackInfo.stream;
        }
      } else {
        guestVideoRef.current.srcObject = null;
      }
    }

    const micTrackInfo = webrtcSnap.guestReceivedTracks.find(
      (t) => t.source === 'microphoneAudio' && t.kind === 'audio'
    );
    if (guestMicAudioRef.current) {
      guestMicAudioRef.current.muted =
        webrtcSnap.guestPlayback.micMutedLocally;
      guestMicAudioRef.current.volume = webrtcSnap.guestPlayback.micVolume;
      if (micTrackInfo) {
        if (guestMicAudioRef.current.srcObject !== micTrackInfo.stream) {
          guestMicAudioRef.current.srcObject = micTrackInfo.stream;
        }
      } else {
        guestMicAudioRef.current.srcObject = null;
      }
    }

    const deviceTrackInfo = webrtcSnap.guestReceivedTracks.find(
      (t) => t.source === 'deviceAudio' && t.kind === 'audio'
    );
    if (guestDeviceAudioRef.current) {
      guestDeviceAudioRef.current.muted =
        webrtcSnap.guestPlayback.deviceAudioMutedLocally;
      guestDeviceAudioRef.current.volume =
        webrtcSnap.guestPlayback.deviceAudioVolume;
      if (deviceTrackInfo) {
        if (guestDeviceAudioRef.current.srcObject !== deviceTrackInfo.stream) {
          guestDeviceAudioRef.current.srcObject = deviceTrackInfo.stream;
        }
      } else {
        guestDeviceAudioRef.current.srcObject = null;
      }
    }

    if (hostViewerMicAudioRef.current) {
      hostViewerMicAudioRef.current.muted =
        webrtcSnap.hostViewerMicMutedLocally;
      if (webrtcSnap.hostReceivedViewerMicStream) {
        if (
          hostViewerMicAudioRef.current.srcObject !==
          webrtcSnap.hostReceivedViewerMicStream
        ) {
          hostViewerMicAudioRef.current.srcObject =
            webrtcSnap.hostReceivedViewerMicStream;
        }
      } else {
        hostViewerMicAudioRef.current.srcObject = null;
      }
    }
  }, [webrtcSnap]);

  // Opt-in local diagnostics sampling
  useEffect(() => {
    if (!webrtcControllerRef.current || !optInDiagnostics) {
      setLiveDiagnostics(null);
      return;
    }

    let active = true;
    webrtcControllerRef.current.setDiagnosticsPolling(true, 1000);
    void webrtcControllerRef.current
      .sampleReadabilityDiagnostics()
      .then((d) => {
        if (active) setLiveDiagnostics(d);
      });

    const interval = setInterval(() => {
      if (!webrtcControllerRef.current || !active) return;
      void webrtcControllerRef.current
        .sampleReadabilityDiagnostics()
        .then((d) => {
          if (active) setLiveDiagnostics(d);
        });
    }, 1000);

    return () => {
      active = false;
      clearInterval(interval);
      webrtcControllerRef.current?.setDiagnosticsPolling(false);
    };
  }, [optInDiagnostics, activeSessionId]);

  // Persist floating panel appearance preferences locally
  useEffect(() => {
    try {
      localStorage.setItem(
        'elm-floating-panel-appearance',
        JSON.stringify(panelAppearance)
      );
    } catch {
      // Ignore storage errors
    }
  }, [panelAppearance]);

  // Keep floating panel reachable when window shrinks, display scale changes, or sidebars toggle
  useEffect(() => {
    const clampToViewport = () => {
      const vp = viewerViewportRef.current;
      const vw = vp ? vp.clientWidth : window.innerWidth;
      const vh = vp ? vp.clientHeight : window.innerHeight;
      setPanelLayout((prev) =>
        clampFloatingPanelLayout(prev, vw, vh, {
          chatOpen: floatingChatOpen,
          settingsOpen: floatingSettingsOpen,
        })
      );
    };
    clampToViewport();
    const vp = viewerViewportRef.current;
    const ro = vp ? new ResizeObserver(clampToViewport) : null;
    if (vp && ro) ro.observe(vp);
    window.addEventListener('resize', clampToViewport);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', clampToViewport);
    };
  }, [floatingChatOpen, floatingSettingsOpen, activeSessionId]);

  // Drag & resize pointer listeners for the floating panel assembly
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const active = panelInteractionRef.current;
      if (!active) return;
      const vp = viewerViewportRef.current;
      const vw = vp ? vp.clientWidth : window.innerWidth;
      const vh = vp ? vp.clientHeight : window.innerHeight;
      const dx = e.clientX - active.startX;
      const dy = e.clientY - active.startY;

      setPanelLayout(() => {
        const next: FloatingPanelLayout =
          active.kind === 'drag'
            ? {
                ...active.initial,
                x: active.initial.x + dx,
                y: active.initial.y + dy,
              }
            : active.kind === 'resize-width'
              ? {
                  ...active.initial,
                  width: active.initial.width + dx,
                }
              : {
                  ...active.initial,
                  width: active.initial.width + dx,
                  chatHeight: active.initial.chatHeight + dy,
                };
        return clampFloatingPanelLayout(next, vw, vh, {
          chatOpen: floatingChatOpen,
          settingsOpen: floatingSettingsOpen,
        });
      });
    };

    const onPointerUp = () => {
      panelInteractionRef.current = null;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [floatingChatOpen, floatingSettingsOpen]);

  // Video-only Presentation View WebRTC loopback over BroadcastChannel
  useEffect(() => {
    if (!metadata) return;
    if (metadata.windowRole === 'presentation') {
      const channel = new BroadcastChannel('elm-presentation-webrtc');
      const pc = new RTCPeerConnection();
      pc.ontrack = (ev) => {
        if (presentationVideoRef.current && ev.streams[0]) {
          presentationVideoRef.current.srcObject = ev.streams[0];
        } else if (presentationVideoRef.current) {
          presentationVideoRef.current.srcObject = new MediaStream([ev.track]);
        }
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          channel.postMessage({
            type: 'ice-to-main',
            candidate: ev.candidate.toJSON(),
          });
        }
      };
      channel.onmessage = async (ev: MessageEvent) => {
        const msg = ev.data as {
          type?: string;
          sdp?: RTCSessionDescriptionInit;
          candidate?: RTCIceCandidateInit;
        };
        if (msg.type === 'offer' && msg.sdp) {
          await pc.setRemoteDescription(msg.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          channel.postMessage({ type: 'answer', sdp: answer });
        } else if (msg.type === 'ice-to-pres' && msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {});
        } else if (msg.type === 'clear') {
          if (presentationVideoRef.current) {
            presentationVideoRef.current.srcObject = null;
          }
        }
      };
      channel.postMessage({ type: 'presentation-ready' });
      return () => {
        channel.close();
        pc.close();
      };
    }

    if (metadata.windowRole !== 'main') return;
    const channel = new BroadcastChannel('elm-presentation-webrtc');
    let pc: RTCPeerConnection | null = null;

    const startMirroring = async () => {
      const srcObj = guestVideoRef.current?.srcObject;
      const videoStream = srcObj instanceof MediaStream ? srcObj : null;
      const videoTrack = videoStream?.getVideoTracks()[0];
      if (!videoTrack) {
        channel.postMessage({ type: 'clear' });
        return;
      }
      pc?.close();
      pc = new RTCPeerConnection();
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          channel.postMessage({
            type: 'ice-to-pres',
            candidate: ev.candidate.toJSON(),
          });
        }
      };
      pc.addTrack(videoTrack, new MediaStream([videoTrack]));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      channel.postMessage({ type: 'offer', sdp: offer });
    };

    channel.onmessage = async (ev: MessageEvent) => {
      const msg = ev.data as {
        type?: string;
        sdp?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
      };
      if (msg.type === 'presentation-ready') {
        await startMirroring();
      } else if (msg.type === 'answer' && msg.sdp && pc) {
        await pc.setRemoteDescription(msg.sdp);
      } else if (msg.type === 'ice-to-main' && msg.candidate && pc) {
        await pc.addIceCandidate(msg.candidate).catch(() => {});
      }
    };

    return () => {
      channel.close();
      pc?.close();
    };
  }, [metadata, webrtcSnap?.guestVideoTracksCount]);

  // Track rendered DOM dimensions & DPI scaling of Guest B video
  useEffect(() => {
    const video = guestVideoRef.current;
    if (!video) return;

    const updateDims = () => {
      if (!guestVideoRef.current) return;
      setRenderedDimensions({
        clientWidth: guestVideoRef.current.clientWidth,
        clientHeight: guestVideoRef.current.clientHeight,
        videoWidth: guestVideoRef.current.videoWidth,
        videoHeight: guestVideoRef.current.videoHeight,
        dpr: window.devicePixelRatio || 1,
      });
    };

    updateDims();
    const ro = new ResizeObserver(updateDims);
    ro.observe(video);
    window.addEventListener('resize', updateDims);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateDims);
    };
  }, [webrtcSnap?.guestVideoTracksCount, viewerMode]);

  const handleVideoResize = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      setRenderedDimensions({
        clientWidth: v.clientWidth,
        clientHeight: v.clientHeight,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        dpr: window.devicePixelRatio || 1,
      });
    }
  };

  const clearAlerts = () => {
    setErrorMessage(null);
    setErrorCode(null);
    setStatusMessage(null);
  };

  const showToast = (
    message: string,
    variant: 'info' | 'error' = 'info'
  ) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastState({ message, variant });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToastState(null);
    }, variant === 'error' ? 3000 : 2200);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!openPeerMenuCode) return;
    const activeCode = openPeerMenuCode;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        setOpenPeerMenuCode(null);
        return;
      }
      const insideMenuOrTrigger = target.closest(
        `[data-peer-menu="${activeCode}"], [data-peer-menu-trigger="${activeCode}"]`
      );
      if (!insideMenuOrTrigger) {
        setOpenPeerMenuCode(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpenPeerMenuCode(null);
        requestAnimationFrame(() => {
          const trigger = document.querySelector<HTMLButtonElement>(
            `[data-peer-menu-trigger="${activeCode}"]`
          );
          trigger?.focus();
        });
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openPeerMenuCode]);

  // Close floating Settings sidebar on outside pointerdown or Escape (keeps sliders/inside clicks open)
  useEffect(() => {
    if (!floatingSettingsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const shouldClose = shouldDismissOnOutsidePointerDown({
        isOpen: floatingSettingsOpen,
        insidePopup: Boolean(target && floatingSettingsSidebarRef.current?.contains(target)),
        insideToggleButton: Boolean(target && floatingSettingsToggleRef.current?.contains(target)),
      });
      if (shouldClose) {
        setFloatingSettingsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldDismissOnKeyDown({ isOpen: floatingSettingsOpen, key: event.key })) {
        event.preventDefault();
        setFloatingSettingsOpen(false);
        requestAnimationFrame(() => {
          floatingSettingsToggleRef.current?.focus();
        });
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [floatingSettingsOpen]);

  // Close Host Source Picker popover on outside pointerdown or Escape
  useEffect(() => {
    if (!hostSourcePickerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const shouldClose = shouldDismissOnOutsidePointerDown({
        isOpen: hostSourcePickerOpen,
        insidePopup: Boolean(target && hostSourcePopoverRef.current?.contains(target)),
        insideToggleButton: Boolean(target && hostSourceToggleRef.current?.contains(target)),
      });
      if (shouldClose) {
        setHostSourcePickerOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldDismissOnKeyDown({ isOpen: hostSourcePickerOpen, key: event.key })) {
        event.preventDefault();
        setHostSourcePickerOpen(false);
        requestAnimationFrame(() => {
          hostSourceToggleRef.current?.focus();
        });
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [hostSourcePickerOpen]);

  // Close Settings, Chat, and Source Picker immediately on unexpected disconnect or teardown
  useEffect(() => {
    if (
      webrtcSnap?.teardownReceipt ||
      webrtcSnap?.connectionState === 'closed'
    ) {
      setFloatingSettingsOpen(false);
      setFloatingChatOpen(false);
      setHostSourcePickerOpen(false);
    }
  }, [webrtcSnap?.teardownReceipt, webrtcSnap?.connectionState]);

  // Launch and synchronize the independent Host Floating Toolbar BrowserWindow
  // ONLY when Host is in an active session; close it & restore main on disconnect.
  const isHostInActiveSession =
    metadata?.windowRole === 'main' &&
    Boolean(snapshot?.activeSession) &&
    Boolean(webrtcSnap) &&
    !webrtcSnap?.teardownReceipt &&
    snapshot?.activeSession?.hostAccountId === account?.accountId;

  useEffect(() => {
    if (metadata?.windowRole !== 'main') return;
    if (!isHostInActiveSession) {
      void window.elmDesktop.toggleHostToolbarWindow(false);
      return;
    }
    void window.elmDesktop.toggleHostToolbarWindow(true);
  }, [metadata?.windowRole, isHostInActiveSession]);

  useEffect(() => {
    if (metadata?.windowRole !== 'main') return;
    const onVisibilityChange = () => {
      setIsDocumentHidden(document.visibilityState !== 'visible');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [metadata?.windowRole]);

  useEffect(() => {
    if (metadata?.windowRole !== 'main') return;
    if (!activeSessionId || !webrtcSnap) {
      readIncomingMessageIdsRef.current.clear();
      setHasUnreadChat(false);
      return;
    }
    const chatVisible = isHostInActiveSession
      ? Boolean(hostOverlayState?.chatOpen)
      : Boolean(floatingChatOpen && !isDocumentHidden);
    const nextUnread = computeUnreadChatState({
      messages: webrtcSnap.messages,
      currentAccountId: account?.accountId,
      chatVisible,
      readIncomingIds: readIncomingMessageIdsRef.current,
    });
    setHasUnreadChat(nextUnread);
  }, [
    metadata?.windowRole,
    activeSessionId,
    webrtcSnap,
    isHostInActiveSession,
    hostOverlayState?.chatOpen,
    floatingChatOpen,
    isDocumentHidden,
    account?.accountId,
  ]);

  useEffect(() => {
    if (metadata?.windowRole !== 'main') return;
    if (!isHostInActiveSession || !snapshot?.activeSession || !webrtcSnap) {
      return;
    }
    void window.elmDesktop.syncHostOverlayState({
      sessionActive: true,
      sessionId: snapshot.activeSession.sessionId,
      peerDisplayName: snapshot.activeSession.guestDisplayName,
      connectionState: webrtcSnap.connectionState,
      iceConnectionState: webrtcSnap.iceConnectionState,
      dataChannelState: webrtcSnap.dataChannelState,
      hostMediaState: webrtcSnap.hostMediaState,
      hostMicMutedLocally: webrtcSnap.hostMicMutedLocally,
      peerMicActive: Boolean(
        webrtcSnap.remoteViewerMicActive ||
          webrtcSnap.hostReceivedViewerMicStream
      ),
      peerMicMutedLocally: webrtcSnap.hostViewerMicMutedLocally,
      peerMicRequestPending: webrtcSnap.hostViewerMicRequestSent,
      isStartingShare,
      isStartingMic,
      isStartingDeviceSound,
      shareableSources,
      selectedSourceId,
      playWasapiTestTone,
      hasUnreadChat,
    });
  }, [
    metadata?.windowRole,
    isHostInActiveSession,
    snapshot?.activeSession,
    webrtcSnap,
    isStartingShare,
    isStartingMic,
    isStartingDeviceSound,
    shareableSources,
    selectedSourceId,
    playWasapiTestTone,
    hasUnreadChat,
  ]);

  const openSettingsModal = () => {
    const saved = deviceSetupState?.localProfile;
    setSettingsDraftName(saved?.name ?? setupNameInput ?? account?.displayName ?? '');
    setSettingsDraftEmail(saved?.email ?? setupEmailInput ?? '');
    setSettingsDraftPhone(saved?.phone ?? setupPhoneInput ?? '');
    setSettingsDraftTheme(themeState.mode);
    setShowSettingsPanel(true);
  };

  const closeSettingsModal = (restoreFocus: boolean = true) => {
    applyThemeToDom(themeState.mode);
    const saved = deviceSetupState?.localProfile;
    setSettingsDraftName(saved?.name ?? setupNameInput ?? '');
    setSettingsDraftEmail(saved?.email ?? setupEmailInput ?? '');
    setSettingsDraftPhone(saved?.phone ?? setupPhoneInput ?? '');
    setSettingsDraftTheme(themeState.mode);
    setShowSettingsPanel(false);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        settingsButtonRef.current?.focus();
      });
    }
  };

  useEffect(() => {
    if (!showSettingsPanel) return;
    const modalEl = settingsModalRef.current;
    if (!modalEl) return;

    const getFocusable = (): HTMLElement[] =>
      Array.from(
        modalEl.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );

    requestAnimationFrame(() => {
      const nameInput = modalEl.querySelector<HTMLElement>('#settings-name');
      (nameInput ?? getFocusable()[0])?.focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSettingsModal(true);
        return;
      }
      if (e.key === 'Tab') {
        const focusables = getFocusable();
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showSettingsPanel, themeState.mode]);

  const handleSaveSettingsModal = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAlerts();
    if (!settingsDraftName.trim()) {
      setErrorCode('INVALID_REQUEST');
      setErrorMessage('Name is required to set up this device.');
      return;
    }
    setSavingProfile(true);
    try {
      const res = await window.elmDesktop.saveLocalProfile({
        name: settingsDraftName,
        email: settingsDraftEmail,
        phone: settingsDraftPhone,
      });
      if (!res.ok || !res.data) {
        setErrorCode(res.errorCode ?? 'INVALID_REQUEST');
        setErrorMessage(res.errorMessage ?? 'Could not save local profile.');
        return;
      }
      setDeviceSetupState(res.data);
      setSetupNameInput(settingsDraftName.trim());
      setSetupEmailInput(settingsDraftEmail.trim());
      setSetupPhoneInput(settingsDraftPhone.trim());
      if (webrtcControllerRef.current && res.data.localProfile) {
        webrtcControllerRef.current.sendPeerContactCard(
          buildOutgoingPeerContactCard(res.data.localProfile)
        );
      }
      if (res.data.registeredAccount) {
        setAccount(res.data.registeredAccount);
        const stored = await window.elmDesktop.getStoredAuthSession();
        if (stored.ok && stored.data) {
          setAccount(stored.data.account);
          applyAuthoritativeSnapshot(stored.data.snapshot);
        }
      }
      if (settingsDraftTheme !== themeState.mode) {
        const updatedTheme = await window.elmDesktop.setThemeMode(settingsDraftTheme);
        setThemeState(updatedTheme);
        applyThemeToDom(updatedTheme.mode);
      }
      setShowSettingsPanel(false);
      requestAnimationFrame(() => {
        settingsButtonRef.current?.focus();
      });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSaveLocalProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAlerts();
    if (!setupNameInput.trim()) {
      setErrorCode('INVALID_REQUEST');
      setErrorMessage('Name is required to set up this device.');
      return;
    }
    setSavingProfile(true);
    try {
      const res = await window.elmDesktop.saveLocalProfile({
        name: setupNameInput,
        email: setupEmailInput,
        phone: setupPhoneInput,
      });
      if (!res.ok || !res.data) {
        setErrorCode(res.errorCode ?? 'INVALID_REQUEST');
        setErrorMessage(res.errorMessage ?? 'Could not save local profile.');
        return;
      }
      setDeviceSetupState(res.data);
      if (res.data.registeredAccount) {
        setAccount(res.data.registeredAccount);
        const [stored, runtime] = await Promise.all([
          window.elmDesktop.getStoredAuthSession(),
          window.elmDesktop.getPresenceRuntimeStatus(),
        ]);
        setPresenceRuntime(runtime);
        if (stored.ok && stored.data) {
          setAccount(stored.data.account);
          setSnapshot(stored.data.snapshot);
        } else if (runtime.snapshot) {
          setSnapshot(runtime.snapshot);
        }
      }
      setShowSettingsPanel(false);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleRetryRegistration = async () => {
    clearAlerts();
    setRetryingRegistration(true);
    try {
      const res = await window.elmDesktop.retryDeviceRegistration();
      if (res.ok && res.data) {
        setDeviceSetupState(res.data);
        if (res.data.registeredAccount) {
          setAccount(res.data.registeredAccount);
          const [stored, runtime] = await Promise.all([
            window.elmDesktop.getStoredAuthSession(),
            window.elmDesktop.getPresenceRuntimeStatus(),
          ]);
          setPresenceRuntime(runtime);
          if (stored.ok && stored.data) {
            setAccount(stored.data.account);
            setSnapshot(stored.data.snapshot);
          } else if (runtime.snapshot) {
            setSnapshot(runtime.snapshot);
          }
        }
      }
    } finally {
      setRetryingRegistration(false);
    }
  };

  const handleTestDoubleSignIn = async (personaKey: string) => {
    clearAlerts();
    const res = await window.elmDesktop.signInWithTestDouble(personaKey);
    if (!res.ok || !res.data) {
      setErrorCode(res.errorCode ?? 'UNAUTHORIZED');
      setErrorMessage(res.errorMessage ?? 'Failed to sign in.');
      return;
    }
    setAccount(res.data.account);
    setSnapshot(res.data.snapshot);
    setStatusMessage(
      `Signed in as ${res.data.account.displayName}. Permanent Friend Code (${res.data.account.friendCode}) loaded from D1 store.`
    );
  };

  const handleSignOut = async () => {
    clearAlerts();
    if (webrtcControllerRef.current) {
      await webrtcControllerRef.current.executeIdempotentTeardown(
        'user_top_bar_disconnect',
        {
          subReason: 'user_sign_out',
          initiatedByAccountId: account?.accountId ?? null,
        }
      );
      webrtcControllerRef.current = null;
    }
    await window.elmDesktop.signOut();
    setAccount(null);
    setSnapshot(null);
    setWebrtcSnap(null);
    setStatusMessage(
      'Signed out. Sign back in anytime to reuse your permanent Friend Code.'
    );
  };

  const handleAttachInMemoryImage = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
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
      const msg = `Unsupported image type "${file.type || 'unknown'}". Supported types: PNG, JPEG, WEBP, GIF.`;
      setChatAttachmentError(msg);
      setErrorMessage(msg);
      return;
    }
    if (file.size <= 0) {
      const msg = 'Image attachment is empty.';
      setChatAttachmentError(msg);
      setErrorMessage(msg);
      return;
    }
    if (file.size > MAX_CHAT_IMAGE_BYTES) {
      const msg = `Image exceeds the ${Math.round(
        MAX_CHAT_IMAGE_BYTES / (1024 * 1024)
      )} MB peer-to-peer transfer limit.`;
      setChatAttachmentError(msg);
      setErrorMessage(msg);
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
        setErrorMessage(validation.error);
        return;
      }
      setPendingImageDataUrl(reader.result);
      setPendingImageName(file.name);
      setPendingImageMimeType(normalizedMime);
      setPendingImageByteLength(file.size);
    };
    reader.onerror = () => {
      const msg = 'Failed to read selected image file.';
      setChatAttachmentError(msg);
      setErrorMessage(msg);
    };
    reader.readAsDataURL(file);
  };

  const handleCopyFriendCode = async () => {
    if (!account) return;
    await window.elmDesktop.copyTextToClipboard(account.friendCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
    showToast(`Copied ${account.friendCode} to clipboard.`);
  };

  const submitInviteRequest = async (params: {
    friendCode: string;
    intent: InviteIntent;
    hostMediaSelection?: HostMediaSelection;
  }) => {
    if (submittingRequest) return;
    clearAlerts();
    setRequestOutcomeModal(null);
    setSubmittingRequest(true);
    try {
      const res = await window.elmDesktop.sendFriendCodeInvite({
        friendCode: params.friendCode,
        intent: params.intent,
        hostMediaSelection: params.hostMediaSelection,
      });
      if (!res.ok || !res.data) {
        if (res.errorCode === 'SELF_INVITE_NOT_ALLOWED') {
          showToast('You cannot connect to your code.', 'error');
          return;
        }
        if (res.errorCode === 'TARGET_OFFLINE') {
          setRequestOutcomeModal({
            kind: 'offline',
            friendCode: params.friendCode.trim().toUpperCase(),
            intent: params.intent,
            hostMediaSelection: params.hostMediaSelection,
          });
          return;
        }
        setErrorCode(res.errorCode ?? 'INVITE_ERROR');
        setErrorMessage(res.errorMessage ?? 'Could not send invite.');
        return;
      }
      if (isValidPresenceSnapshot(res.data.snapshot)) {
        applyAuthoritativeSnapshot(res.data.snapshot);
      } else if (res.data.invite) {
        snapshotEpochRef.current += 1;
        setSnapshot((prev) =>
          prev
            ? {
                ...prev,
                outgoingInvite: res.data!.invite,
                recentExpiredOutgoingInvite: null,
              }
            : prev
        );
        void window.elmDesktop.getPresenceSnapshot().then((fresh) => {
          if (fresh.ok && fresh.data && isValidPresenceSnapshot(fresh.data.snapshot)) {
            applyAuthoritativeSnapshot(fresh.data.snapshot);
          }
        });
      }
      if (params.intent === 'invite') {
        setInviteDialogOpen(false);
        setInviteTargetCode('');
      } else {
        setEnteredFriendCode('');
      }
    } finally {
      setSubmittingRequest(false);
    }
  };

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitInviteRequest({
      friendCode: enteredFriendCode,
      intent: 'connect',
    });
  };

  const handleSendReverseInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitInviteRequest({
      friendCode: inviteTargetCode,
      intent: 'invite',
      hostMediaSelection: inviteHostMedia,
    });
  };

  const handleCancelOutgoingInvite = async (inviteId: string) => {
    if (cancellingInviteId) return;
    clearAlerts();
    setCancellingInviteId(inviteId);
    try {
      const res = await window.elmDesktop.cancelOutgoingInvite(inviteId);
      if (!res.ok || !res.data) {
        setErrorCode(res.errorCode ?? 'CANCEL_ERROR');
        setErrorMessage(res.errorMessage ?? 'Could not cancel request.');
        const epoch = snapshotEpochRef.current;
        const fresh = await window.elmDesktop.getPresenceSnapshot();
        if (epoch === snapshotEpochRef.current && fresh.ok && fresh.data) {
          applyAuthoritativeSnapshot(fresh.data.snapshot);
        }
        return;
      }
      if (isValidPresenceSnapshot(res.data.snapshot)) {
        applyAuthoritativeSnapshot(res.data.snapshot);
      } else {
        snapshotEpochRef.current += 1;
        setSnapshot((prev) =>
          prev
            ? {
                ...prev,
                outgoingInvite: null,
              }
            : prev
        );
        void window.elmDesktop.getPresenceSnapshot().then((fresh) => {
          if (fresh.ok && fresh.data && isValidPresenceSnapshot(fresh.data.snapshot)) {
            applyAuthoritativeSnapshot(fresh.data.snapshot);
          }
        });
      }
    } finally {
      setCancellingInviteId(null);
    }
  };

  const handleCopyInvitationSnippet = async () => {
    if (!account) return;
    await window.elmDesktop.copyTextToClipboard(
      `Connect to my Elm-AnyDesk device using Device Code: ${account.friendCode}`
    );
    setCopiedInvitation(true);
    setTimeout(() => setCopiedInvitation(false), 2000);
    showToast('Copied invitation to clipboard.');
  };

  const handleRespondToInvite = async (
    invite: InviteSummary,
    action: 'accept' | 'decline'
  ) => {
    clearAlerts();
    const res = await window.elmDesktop.respondToInvite({
      inviteId: invite.inviteId,
      action,
      mediaSelection: action === 'accept' ? preAcceptMedia : undefined,
    });
    if (!res.ok || !res.data) {
      setErrorCode(res.errorCode ?? 'RESPOND_ERROR');
      setErrorMessage(res.errorMessage ?? 'Could not respond to invite.');
      return;
    }
    if (isValidPresenceSnapshot(res.data.snapshot)) {
      applyAuthoritativeSnapshot(res.data.snapshot);
    } else if (action === 'accept' && res.data.session) {
      const approvedSession = res.data.session;
      snapshotEpochRef.current += 1;
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              incomingInvites: [],
              outgoingInvite: null,
              recentExpiredOutgoingInvite: null,
              activeSession: approvedSession,
            }
          : prev
      );
      void window.elmDesktop.getPresenceSnapshot().then((fresh) => {
        if (fresh.ok && fresh.data && isValidPresenceSnapshot(fresh.data.snapshot)) {
          applyAuthoritativeSnapshot(fresh.data.snapshot);
        }
      });
    } else if (action === 'decline') {
      snapshotEpochRef.current += 1;
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              incomingInvites: prev.incomingInvites.filter(
                (item) => item.inviteId !== invite.inviteId
              ),
            }
          : prev
      );
    }
    if (action === 'accept' && res.data.session) {
      setStatusMessage(
        `Accepted invite from ${invite.requesterDisplayName}. Connecting peer session. Media will not start until you click "Start Sharing".`
      );
    } else {
      showToast(
        `Declined invite from ${invite.requesterDisplayName} (${invite.requesterFriendCode}).`
      );
    }
  };

  const handleDisconnectSession = async () => {
    clearAlerts();
    const targetSessionId =
      snapshot?.activeSession?.sessionId ??
      volatileChatState?.session?.sessionId;

    if (webrtcControllerRef.current) {
      await webrtcControllerRef.current.executeIdempotentTeardown(
        'user_top_bar_disconnect',
        {
          subReason:
            account?.accountId ===
            webrtcControllerRef.current.session.guestAccountId
              ? 'top_bar_guest_b'
              : 'top_bar_host_a',
          initiatedByAccountId: account?.accountId ?? null,
        }
      );
      webrtcControllerRef.current = null;
    }
    clearGuestMediaElements();
    setFloatingChatOpen(false);
    setFloatingSettingsOpen(false);
    setWebrtcSnap(null);
    const res = await window.elmDesktop.disconnectActiveSession({
      sessionId: targetSessionId,
      reason: 'user_top_bar_disconnect',
      subReason: 'user_top_bar_disconnect',
      callerAccountId: account?.accountId,
    });
    if (res.ok && res.data && isValidPresenceSnapshot(res.data.snapshot)) {
      applyAuthoritativeSnapshot(res.data.snapshot);
    } else if (
      res.ok ||
      res.status === 409 ||
      res.errorCode === 'SESSION_ALREADY_ENDED'
    ) {
      snapshotEpochRef.current += 1;
      setSnapshot((prev) => (prev ? { ...prev, activeSession: null } : prev));
    }
    setStatusMessage(
      res.status === 409 || res.errorCode === 'SESSION_ALREADY_ENDED'
        ? 'Session had already ended on the server. All media and permissions are cleared. Send a fresh invite to connect again.'
        : 'Session ended. All media and permissions have been cleared. Send a fresh invite to connect again.'
    );
  };

  const handleRefreshSources = async () => {
    const sources = await window.elmDesktop.listShareableSources();
    setShareableSources(sources);
    setSelectedSourceId((prev) => {
      if (sources.length === 0) return null;
      if (prev && sources.some((s) => s.id === prev)) return prev;
      return sources[0].id;
    });
  };

  const handleSelectHostSource = async (nextSourceId: string) => {
    setSelectedSourceId(nextSourceId);
    const ctrl = webrtcControllerRef.current;
    if (!ctrl || !webrtcSnap?.hostMediaState.screenVideo.active) {
      return;
    }
    setIsStartingShare(true);
    try {
      const nextSnap = await ctrl.switchScreenSource(nextSourceId);
      const nextScreen = nextSnap.hostMediaState.screenVideo;
      if (!nextScreen.active && nextScreen.message) {
        showToast(nextScreen.message, 'error');
      } else if (nextScreen.status === 'permission_denied' || nextScreen.status === 'source_disappeared') {
        showToast(nextScreen.message, 'error');
      }
      setHostSourcePickerOpen(false);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Failed to switch screen source.',
        'error'
      );
    } finally {
      setIsStartingShare(false);
    }
  };

  const handleToggleHostMic = async () => {
    const ctrl = webrtcControllerRef.current;
    if (!ctrl || !webrtcSnap) return;
    const micState = webrtcSnap.hostMediaState.microphoneAudio;
    if (!micState.approved) return;
    if (micState.active) {
      ctrl.setHostMicrophoneMuted(!webrtcSnap.hostMicMutedLocally);
      return;
    }
    if (
      micState.status === 'permission_denied' ||
      micState.status === 'unsupported' ||
      micState.status === 'source_disappeared'
    ) {
      return;
    }
    setIsStartingMic(true);
    try {
      const nextSnap = await ctrl.startHostSource('microphoneAudio');
      const nextMic = nextSnap.hostMediaState.microphoneAudio;
      if (!nextMic.active && nextMic.message) {
        showToast(nextMic.message, 'error');
      }
    } finally {
      setIsStartingMic(false);
    }
  };

  const handleToggleHostDeviceSound = async () => {
    const ctrl = webrtcControllerRef.current;
    if (!ctrl || !webrtcSnap) return;
    const soundState = webrtcSnap.hostMediaState.deviceAudio;
    if (!soundState.approved) return;
    if (soundState.active) {
      await ctrl.stopHostSource('deviceAudio');
      showToast('Device sound stopped.');
      return;
    }
    if (
      soundState.status === 'permission_denied' ||
      soundState.status === 'unsupported' ||
      soundState.status === 'source_disappeared'
    ) {
      return;
    }
    setIsStartingDeviceSound(true);
    try {
      const nextSnap = await ctrl.startHostSource('deviceAudio', {
        playWasapiTestTone,
      });
      const nextSound = nextSnap.hostMediaState.deviceAudio;
      if (!nextSound.active && nextSound.message) {
        showToast(nextSound.message, 'error');
      }
    } finally {
      setIsStartingDeviceSound(false);
    }
  };

  const handleStartOrRestartHostScreen = async (sourceOverride?: string | null) => {
    clearAlerts();
    const ctrl = webrtcControllerRef.current;
    if (!ctrl || !webrtcSnap) return;
    if (!webrtcSnap.hostMediaState.screenVideo.approved) return;

    let targetSourceId = sourceOverride ?? selectedSourceId;
    if (!targetSourceId) {
      const sources = await window.elmDesktop.listShareableSources();
      setShareableSources(sources);
      targetSourceId = sources[0]?.id ?? null;
      setSelectedSourceId(targetSourceId);
      if (!targetSourceId) {
        showToast('No shareable display or window found.', 'error');
        return;
      }
    }

    setIsStartingShare(true);
    try {
      if (webrtcSnap.hostMediaState.screenVideo.active) {
        await ctrl.stopHostSource('screenVideo');
      }
      const nextSnap = await ctrl.startHostSource('screenVideo', {
        selectedSourceId: targetSourceId,
      });
      setHostSourcePickerOpen(false);
      const sv = nextSnap.hostMediaState.screenVideo;
      if (sv.active) {
        showToast('Screen sharing started.');
      } else if (sv.message) {
        showToast(sv.message, 'error');
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Failed to start screen sharing.',
        'error'
      );
    } finally {
      setIsStartingShare(false);
    }
  };

  const handleStopHostScreen = async () => {
    const ctrl = webrtcControllerRef.current;
    if (!ctrl) return;
    await ctrl.stopHostSource('screenVideo');
    showToast('Screen sharing stopped.');
  };

  const handleToggleHostPeerMic = () => {
    const ctrl = webrtcControllerRef.current;
    if (!ctrl || !webrtcSnap) return;
    if (
      webrtcSnap.remoteViewerMicActive ||
      webrtcSnap.hostReceivedViewerMicStream
    ) {
      ctrl.setHostViewerMicrophoneMuted(!webrtcSnap.hostViewerMicMutedLocally);
      return;
    }
    const sent = ctrl.requestViewerMicrophone();
    if (sent) {
      showToast('Requested Viewer to turn on microphone.');
    } else {
      showToast('DataChannel is not open yet.', 'error');
    }
  };

  const handleToggleViewerMic = async () => {
    const ctrl = webrtcControllerRef.current;
    if (!ctrl) return;
    const nextSnap = await ctrl.toggleViewerMicrophone();
    if (nextSnap.viewerMicStatus === 'permission_denied') {
      showToast(
        nextSnap.lastStatusBanner || 'Microphone permission denied or unavailable.',
        'error'
      );
    } else if (nextSnap.viewerMicActive) {
      showToast('Your microphone is now ON.');
    } else {
      showToast('Your microphone is now OFF.');
    }
  };

  // Subscribe in Main Window to actions dispatched from independent Host overlay windows
  const hostActionHandlersRef = useRef({
    toggleMic: () => void handleToggleHostMic(),
    stopMic: () => void webrtcControllerRef.current?.stopHostSource('microphoneAudio'),
    toggleDeviceSound: () => void handleToggleHostDeviceSound(),
    togglePeerMic: () => handleToggleHostPeerMic(),
    startScreen: () => void handleStartOrRestartHostScreen(),
    stopScreen: () => void handleStopHostScreen(),
    selectSource: (sourceId: string) => void handleSelectHostSource(sourceId),
    refreshSources: () => void handleRefreshSources(),
    endSession: () => void handleDisconnectSession(),
    focusMain: () => void window.elmDesktop.restoreAndFocusMainWindow(),
  });
  hostActionHandlersRef.current = {
    toggleMic: () => void handleToggleHostMic(),
    stopMic: () => void webrtcControllerRef.current?.stopHostSource('microphoneAudio'),
    toggleDeviceSound: () => void handleToggleHostDeviceSound(),
    togglePeerMic: () => handleToggleHostPeerMic(),
    startScreen: () => void handleStartOrRestartHostScreen(),
    stopScreen: () => void handleStopHostScreen(),
    selectSource: (sourceId: string) => void handleSelectHostSource(sourceId),
    refreshSources: () => void handleRefreshSources(),
    endSession: () => void handleDisconnectSession(),
    focusMain: () => void window.elmDesktop.restoreAndFocusMainWindow(),
  };

  useEffect(() => {
    if (metadata?.windowRole !== 'main') return;
    const unsub = window.elmDesktop.onHostToolbarAction((action) => {
      switch (action.type) {
        case 'toggle-mic':
          hostActionHandlersRef.current.toggleMic();
          break;
        case 'stop-mic':
          hostActionHandlersRef.current.stopMic();
          break;
        case 'toggle-device-sound':
          hostActionHandlersRef.current.toggleDeviceSound();
          break;
        case 'toggle-peer-mic':
          hostActionHandlersRef.current.togglePeerMic();
          break;
        case 'start-screen':
          hostActionHandlersRef.current.startScreen();
          break;
        case 'stop-screen':
          hostActionHandlersRef.current.stopScreen();
          break;
        case 'select-source':
          hostActionHandlersRef.current.selectSource(action.sourceId);
          break;
        case 'refresh-sources':
          hostActionHandlersRef.current.refreshSources();
          break;
        case 'end-session':
          hostActionHandlersRef.current.endSession();
          break;
        case 'focus-main':
          hostActionHandlersRef.current.focusMain();
          break;
        default:
          break;
      }
    });
    return () => {
      unsub();
    };
  }, [metadata?.windowRole]);

  const handleSendChatFromAnyWindow = async (e: React.FormEvent) => {
    e.preventDefault();
    setChatAttachmentError(null);
    const rawText = chatInputText.trim();
    const imageUrl = pendingImageDataUrl;
    const imageName = pendingImageName;
    const imageMime = pendingImageMimeType;
    const imageBytes = pendingImageByteLength;
    if (!rawText && !imageUrl) return;

    const text =
      rawText || `[In-memory image: ${imageName ?? 'image'}]`;

    const ctrl = webrtcControllerRef.current;
    if (!ctrl) {
      setChatAttachmentError('No active session.');
      return;
    }
    const activeSender: 'host' | 'guest' =
      account?.accountId === ctrl.session.guestAccountId ? 'guest' : 'host';

    const localProfileName =
      deviceSetupState?.localProfile?.name?.trim() ||
      account?.displayName?.trim() ||
      undefined;
    ctrl.setLocalDisplayName(localProfileName);
    if (imageUrl && imageMime) {
      const result = ctrl.sendChatImageOverDataChannel({
        sender: activeSender,
        senderAccountId:
          account?.accountId ??
          (activeSender === 'host'
            ? ctrl.session.hostAccountId
            : ctrl.session.guestAccountId),
        senderDisplayName:
          localProfileName ??
          (activeSender === 'host'
            ? ctrl.session.hostDisplayName
            : ctrl.session.guestDisplayName),
        text,
        mimeType: imageMime,
        byteLength: imageBytes,
        dataUrl: imageUrl,
      });
      if (!result.ok) {
        setChatAttachmentError(result.error);
        return;
      }
      setChatInputText('');
      setPendingImageDataUrl(null);
      setPendingImageName(null);
      setPendingImageMimeType(null);
      setPendingImageByteLength(0);
      return;
    }

    setChatInputText('');
    await ctrl.sendChatMessageOverDataChannel({
      sender: activeSender,
      text,
      senderDisplayName: localProfileName,
    });
  };

  const handleRunVerificationMatrix = async () => {
    clearAlerts();
    setRunningMatrix(true);
    try {
      const report = await runAllWebRtcSessionVerificationMatrix();
      setMatrixReport(report);
      setStatusMessage(
        'Completed 5-combination WebRTC verification matrix (chat-only, video-only, mic-only, device-only, combined + independent stop & fault resilience).'
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningMatrix(false);
    }
  };

  const handleRunPhase4Suite = async () => {
    clearAlerts();
    setRunningPhase4(true);
    try {
      const report = await runPhase4LifecycleAndTeardownVerificationSuite();
      setPhase4Report(report);
      setStatusMessage(
        `Completed Phase 4 Idempotent Teardown & Liveness Verification Matrix (allPassed=${String(
          report.allPassed
        )}).`
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningPhase4(false);
    }
  };

  const handleRunMinimizeRestoreCycle = async () => {
    const data = await window.elmDesktop.runTaskbarMinimizeRestoreCycle();
    setDwmTelemetry(data);
  };

  if (!metadata) {
    return (
      <main className="app-shell">
        <section className="card">
          <p>Loading Elm-AnyDesk runtime...</p>
        </section>
      </main>
    );
  }

  // ============================================================================
  // VIDEO-ONLY PRESENTATION VIEW WINDOW (windowRole === 'presentation')
  // ============================================================================
  if (metadata.windowRole === 'presentation') {
    return (
      <main
        className="presentation-viewport"
        data-testid="presentation-view-window"
      >
        <video
          ref={presentationVideoRef}
          autoPlay
          playsInline
          muted
          className="presentation-video-full"
        />
      </main>
    );
  }

  // ============================================================================
  // INDEPENDENT HOST FLOATING TOOLBAR WINDOW (windowRole === 'host-toolbar')
  // ============================================================================
  if (metadata.windowRole === 'host-toolbar') {
    if (!hostOverlayState) {
      return (
        <main className="overlay-toolbar-shell">
          <div className="overlay-toolbar-bar muted">Connecting toolbar…</div>
        </main>
      );
    }
    return (
      <HostFloatingToolbarWindow
        overlay={hostOverlayState}
        themeState={themeState}
      />
    );
  }

  // ============================================================================
  // INDEPENDENT HOST SOURCE PICKER POPUP (windowRole === 'host-source-picker')
  // ============================================================================
  if (metadata.windowRole === 'host-source-picker') {
    if (!hostOverlayState) {
      return <main className="overlay-popup-shell muted">Loading sources…</main>;
    }
    return (
      <HostSourcePickerPopup
        overlay={hostOverlayState}
        themeState={themeState}
      />
    );
  }

  // ============================================================================
  // INDEPENDENT HOST SETTINGS POPUP (windowRole === 'host-settings')
  // ============================================================================
  if (metadata.windowRole === 'host-settings') {
    if (!hostOverlayState) {
      return <main className="overlay-popup-shell muted">Loading settings…</main>;
    }
    return (
      <HostSettingsPopup
        overlay={hostOverlayState}
        themeState={themeState}
        onToggleTheme={() => void handleToggleTheme()}
      />
    );
  }

  // ============================================================================
  // SEPARATE MOVABLE PRIVATE CHAT POPUP (windowRole === 'chat')
  // ============================================================================
  if (metadata.windowRole === 'chat') {
    return (
      <PrivateChatPopupWindow
        volatileState={volatileChatState}
        appearance={hostOverlayState?.appearance ?? panelAppearance}
        themeState={themeState}
        onToggleTheme={() => void handleToggleTheme()}
      />
    );
  }

  // ============================================================================
  // MAIN APPLICATION WINDOW (windowRole === 'main')
  // ============================================================================
  const hasGuestMicTrack = Boolean(
    webrtcSnap?.guestReceivedTracks.some(
      (t) => t.source === 'microphoneAudio' && t.readyState === 'live'
    )
  );
  const hasGuestDeviceAudioTrack = Boolean(
    webrtcSnap?.guestReceivedTracks.some(
      (t) => t.source === 'deviceAudio' && t.readyState === 'live'
    )
  );
  const updateViewerAppearance = (patch: Partial<FloatingPanelAppearance>) => {
    setPanelAppearance((prev) => sanitizeFloatingPanelAppearance({ ...prev, ...patch }));
    void window.elmDesktop.setFloatingAppearance(patch);
  };
  const isLocalHost =
    Boolean(snapshot?.activeSession) &&
    snapshot?.activeSession?.hostAccountId === account?.accountId;
  const transportStatus = webrtcSnap
    ? getTransportStatusDisplay(webrtcSnap)
    : null;
  const chatStatus = webrtcSnap ? getChatStatusDisplay(webrtcSnap) : null;
  const stageStatus = webrtcSnap
    ? getSessionStageStatus({
        isLocalHost,
        isStartingShare,
        webrtcSnap,
      })
    : null;

  const isSettingsDirty =
    settingsDraftName.trim() !==
      (deviceSetupState?.localProfile?.name ?? setupNameInput).trim() ||
    settingsDraftEmail.trim() !==
      (deviceSetupState?.localProfile?.email ?? setupEmailInput).trim() ||
    settingsDraftPhone.trim() !==
      (deviceSetupState?.localProfile?.phone ?? setupPhoneInput).trim() ||
    settingsDraftTheme !== themeState.mode;

  return (
    <main className={isLocalHost ? 'app-shell host-ui-scope' : 'app-shell'}>
      {/* SIMPLE CUSTOM ELECTRON TITLE BAR */}
      <header className="top-bar chrome-titlebar" data-testid="chrome-titlebar">
        <div className="titlebar-brand">
          <svg
            className="brand-mark"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <rect width="24" height="24" rx="4" fill="var(--accent-action-bg)" />
            <rect
              x="4"
              y="4"
              width="16"
              height="16"
              rx="2"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="1.75"
            />
            <rect x="8" y="8" width="8" height="8" rx="1" fill="#FFFFFF" />
          </svg>
          <h1>Elm-AnyDesk</h1>
        </div>

        <div className="window-controls no-drag" aria-label="Window controls">
          <button
            type="button"
            data-testid="win-minimize-button"
            className="win-control-btn no-drag"
            aria-label="Minimize window"
            title={isLocalHost ? undefined : 'Minimize'}
            onClick={() => void window.elmDesktop.minimizeWindow()}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
          <button
            type="button"
            data-testid="win-maximize-button"
            className="win-control-btn no-drag"
            aria-label={isWindowMaximized ? 'Restore window' : 'Maximize window'}
            title={
              isLocalHost
                ? undefined
                : isWindowMaximized
                  ? 'Restore'
                  : 'Maximize'
            }
            onClick={() =>
              void window.elmDesktop
                .toggleMaximizeWindow()
                .then((res) => setIsWindowMaximized(res.maximized))
            }
          >
            {isWindowMaximized ? (
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="3.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1.5" y="3.5" width="7" height="7" fill="var(--surface-elevated)" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            )}
          </button>
          <button
            type="button"
            data-testid="win-close-button"
            className="win-control-btn win-control-close no-drag"
            aria-label="Close window"
            title={isLocalHost ? undefined : 'Close'}
            onClick={() => void window.elmDesktop.closeWindow()}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <line x1="2.2" y1="2.2" x2="9.8" y2="9.8" stroke="currentColor" strokeWidth="1.4" />
              <line x1="9.8" y1="2.2" x2="2.2" y2="9.8" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>
      </header>

      {/* COMPACT STATUS, DEVICE CODE & CONTROLS BAR */}
      <section className="device-header-strip" data-testid="device-header-strip">
        <div className="device-header-left">
          {(() => {
            if (!account) {
              return null;
            }
            const isConfirmedOnline =
              Boolean(account) &&
              presenceRuntime.connectionState === 'online' &&
              Boolean(snapshot?.online);
            const isConnecting =
              deviceSetupState?.registrationStatus === 'registering' ||
              presenceRuntime.connectionState === 'connecting';
            const isReconnecting =
              presenceRuntime.connectionState === 'reconnecting';
            const pillVariant = isConfirmedOnline
              ? 'online'
              : isConnecting || isReconnecting
                ? 'pending'
                : 'offline';
            const pillLabel = isConfirmedOnline
              ? 'Online'
              : isReconnecting
                ? 'Reconnecting...'
                : isConnecting
                  ? 'Connecting...'
                  : presenceRuntime.connectionState === 'unknown'
                    ? 'Unknown'
                    : 'Offline';
            const pillTitle = isConfirmedOnline
              ? 'Automatically connected to Elm signaling backend'
              : isReconnecting
                ? 'Connection interrupted — retrying automatically'
                : isConnecting
                  ? 'Connecting to Elm signaling backend...'
                  : 'Offline — unable to reach Elm signaling backend';
            return (
              <div
                role="status"
                aria-live="polite"
                data-testid="presence-status-pill"
                className={`presence-pill no-drag ${pillVariant}`}
                title={isLocalHost ? undefined : pillTitle}
              >
                <span className="presence-dot-inline" aria-hidden="true" />
                <span>{pillLabel}</span>
              </div>
            );
          })()}

          {account?.friendCode ? (
            <div className="device-code-inline">
              <code
                data-testid="friend-code-value"
                aria-label="Your Device Code"
                className="device-code-inline-value"
              >
                {account.friendCode}
              </code>
              <button
                type="button"
                data-testid="copy-friend-code-button"
                className="small-secondary-btn"
                onClick={handleCopyFriendCode}
              >
                {copiedCode ? 'Copied!' : 'Copy Code'}
              </button>
              <button
                type="button"
                data-testid="open-invite-dialog-button"
                className="small-secondary-btn"
                disabled={Boolean(snapshot?.activeSession)}
                onClick={() => {
                  setInviteTargetCode('');
                  setInviteHostMedia({
                    screenVideo: true,
                    microphoneAudio: false,
                    deviceAudio: false,
                  });
                  setInviteDialogOpen(true);
                }}
              >
                Invite
              </button>
            </div>
          ) : deviceSetupState && (deviceSetupState.profileCompleted || account) ? (
            <div
              className="device-code-inline offline"
              data-testid="offline-registration-status"
            >
              <span className="muted">
                {deviceSetupState.registrationMessage ||
                  'Offline before registration: unable to assign your device code yet.'}
              </span>
              <button
                type="button"
                data-testid="retry-registration-button"
                className="small-secondary-btn"
                disabled={retryingRegistration}
                onClick={() => void handleRetryRegistration()}
              >
                {retryingRegistration ? 'Retrying...' : 'Retry'}
              </button>
            </div>
          ) : (
            <span className="muted">Complete local profile setup to receive a Device Code.</span>
          )}
        </div>

        <div className="device-header-actions">
          {snapshot?.activeSession && (
            <button
              type="button"
              data-testid="top-bar-disconnect-button"
              className="danger-btn"
              onClick={handleDisconnectSession}
            >
              Disconnect
            </button>
          )}
          {(deviceSetupState?.profileCompleted || account) && (
            <button
              ref={settingsButtonRef}
              type="button"
              data-testid="settings-profile-button"
              className="small-secondary-btn"
              onClick={openSettingsModal}
            >
              Settings
            </button>
          )}
          <ThemeToggleButton
            themeState={themeState}
            suppressTooltip={isLocalHost}
            onToggle={() => void handleToggleTheme()}
          />
        </div>
      </section>

      {errorMessage && (
        <section className="card card-error">
          <div className="alert-header">
            <strong>
              {errorCode ? `[${errorCode}] ` : ''}
              Action Blocked
            </strong>
            <button
              type="button"
              className="small-secondary-btn"
              onClick={clearAlerts}
            >
              Dismiss
            </button>
          </div>
          <p>{errorMessage}</p>
        </section>
      )}

      {statusMessage && (
        <section className="card card-info">
          <p>{statusMessage}</p>
        </section>
      )}

      {webrtcSnap?.lastStatusBanner && (
        <section className="card card-info">
          <strong>Status: </strong>
          <span>{webrtcSnap.lastStatusBanner}</span>
        </section>
      )}

      {showSettingsPanel && (deviceSetupState?.profileCompleted || account) && (
        <div
          className="modal-backdrop"
          data-testid="settings-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              closeSettingsModal(true);
            }
          }}
        >
          <div
            ref={settingsModalRef}
            className="settings-modal-dialog card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-title"
            data-testid="settings-profile-card"
          >
            <div className="settings-modal-header">
              <div>
                <h2 id="settings-modal-title">Settings</h2>
                <p className="muted">
                  Stored locally on this device only. Never uploaded to Cloudflare.
                </p>
              </div>
              <button
                type="button"
                data-testid="settings-close-x-button"
                className="modal-close-x-btn"
                aria-label="Close settings"
                onClick={() => closeSettingsModal(true)}
              >
                ×
              </button>
            </div>

            <form className="setup-form" onSubmit={(e) => void handleSaveSettingsModal(e)}>
              <div className="settings-modal-section">
                <h3>My Profile</h3>
                <div className="setup-field">
                  <label htmlFor="settings-name">Name *</label>
                  <input
                    id="settings-name"
                    type="text"
                    className="code-input"
                    placeholder="Your name"
                    value={settingsDraftName}
                    onChange={(e) => setSettingsDraftName(e.target.value)}
                    required
                    maxLength={60}
                  />
                </div>
                <div className="setup-field">
                  <label htmlFor="settings-email">Email (optional)</label>
                  <input
                    id="settings-email"
                    type="email"
                    className="code-input"
                    placeholder="name@example.com"
                    value={settingsDraftEmail}
                    onChange={(e) => setSettingsDraftEmail(e.target.value)}
                    maxLength={120}
                  />
                </div>
                <div className="setup-field">
                  <label htmlFor="settings-phone">Phone (optional)</label>
                  <input
                    id="settings-phone"
                    type="tel"
                    className="code-input"
                    placeholder="+1 555 0100"
                    value={settingsDraftPhone}
                    onChange={(e) => setSettingsDraftPhone(e.target.value)}
                    maxLength={40}
                  />
                </div>
              </div>

              <div className="settings-modal-section">
                <h3>Appearance</h3>
                <div className="settings-theme-row">
                  <span className="settings-theme-label">Theme</span>
                  <div
                    className="settings-theme-options"
                    role="group"
                    aria-label="Theme selection"
                  >
                    <button
                      type="button"
                      data-testid="settings-theme-dark"
                      aria-pressed={settingsDraftTheme === 'dark'}
                      className={`small-secondary-btn ${
                        settingsDraftTheme === 'dark' ? 'active-view-btn' : ''
                      }`}
                      onClick={() => {
                        setSettingsDraftTheme('dark');
                        applyThemeToDom('dark');
                      }}
                    >
                      Dark
                    </button>
                    <button
                      type="button"
                      data-testid="settings-theme-light"
                      aria-pressed={settingsDraftTheme === 'light'}
                      className={`small-secondary-btn ${
                        settingsDraftTheme === 'light' ? 'active-view-btn' : ''
                      }`}
                      onClick={() => {
                        setSettingsDraftTheme('light');
                        applyThemeToDom('light');
                      }}
                    >
                      Light
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-modal-footer">
                {isSettingsDirty && (
                  <span className="muted settings-unsaved-note">
                    Unsaved changes
                  </span>
                )}
                <button
                  type="button"
                  data-testid="settings-cancel-button"
                  className="secondary-btn"
                  onClick={() => closeSettingsModal(true)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="settings-save-button"
                  className="primary-btn"
                  disabled={savingProfile || !settingsDraftName.trim()}
                >
                  {savingProfile ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {!deviceSetupState ? (
        <section className="card">
          <p className="muted">Loading Elm-AnyDesk...</p>
        </section>
      ) : !deviceSetupState.profileCompleted && !account ? (
        <section className="card setup-card" data-testid="first-launch-setup-card">
          <h2>Set up this device</h2>
          <p className="muted">
            Your profile is saved locally on this device and is never sent to
            the backend.
          </p>
          <form className="setup-form" onSubmit={handleSaveLocalProfile}>
            <div className="setup-field">
              <label htmlFor="setup-name">Name *</label>
              <input
                id="setup-name"
                type="text"
                className="code-input"
                placeholder="Enter your name"
                value={setupNameInput}
                onChange={(e) => setSetupNameInput(e.target.value)}
                required
                maxLength={60}
              />
            </div>
            <div className="setup-field">
              <label htmlFor="setup-email">Email (optional)</label>
              <input
                id="setup-email"
                type="email"
                className="code-input"
                placeholder="name@example.com"
                value={setupEmailInput}
                onChange={(e) => setSetupEmailInput(e.target.value)}
                maxLength={120}
              />
            </div>
            <div className="setup-field">
              <label htmlFor="setup-phone">Phone number (optional)</label>
              <input
                id="setup-phone"
                type="tel"
                className="code-input"
                placeholder="+1 555 0100"
                value={setupPhoneInput}
                onChange={(e) => setSetupPhoneInput(e.target.value)}
                maxLength={40}
              />
            </div>
            <div className="actions-row">
              <button
                type="submit"
                data-testid="setup-continue-button"
                className="primary-btn"
                disabled={savingProfile || !setupNameInput.trim()}
              >
                {savingProfile ? 'Setting up...' : 'Continue'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <>
          {metadata.devModeEnabled && (
            <section className="card card-full">
              <div className="persona-switcher-bar">
                <span className="muted">
                  Dev Mode Identity (
                  {account
                    ? `${account.displayName} — ${account.friendCode}`
                    : 'Not Registered'}
                  ):
                </span>
                <div className="actions-row">
                  <button
                    type="button"
                    className="small-secondary-btn"
                    onClick={() => handleTestDoubleSignIn('alice')}
                  >
                    Alice
                  </button>
                  <button
                    type="button"
                    className="small-secondary-btn"
                    onClick={() => handleTestDoubleSignIn('bob')}
                  >
                    Bob
                  </button>
                  <button
                    type="button"
                    className="small-secondary-btn"
                    onClick={() => handleTestDoubleSignIn('charlie')}
                  >
                    Charlie
                  </button>
                  <button
                    type="button"
                    className="small-secondary-btn"
                    onClick={handleSignOut}
                  >
                    Reset
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* COMPACT HOST ACTIVE-SESSION STATUS CARD (CONTROLS LIVE IN INDEPENDENT FLOATING TOOLBAR) */}
          {snapshot?.activeSession && webrtcSnap && isLocalHost && (
            <section
              className="card card-full"
              data-testid="host-active-session-card"
            >
              <audio
                ref={hostViewerMicAudioRef}
                autoPlay
                playsInline
                style={{ display: 'none' }}
              />
              <div className="subcard-header">
                <div>
                  <span
                    className={`presence-pill ${
                      webrtcSnap.hostMediaState.screenVideo.active
                        ? 'online'
                        : transportStatus?.tone ?? 'pending'
                    }`}
                  >
                    {webrtcSnap.hostMediaState.screenVideo.active
                      ? 'Sharing via Floating Toolbar'
                      : 'Host Session Connected'}
                  </span>
                  <h2 style={{ marginTop: '6px' }}>
                    Peer: {snapshot.activeSession.guestDisplayName}
                  </h2>
                  <p className="muted">
                    Use the independent floating toolbar for screen, mic,
                    device sound, source selection, and private chat. You can
                    minimize this window at any time without interrupting your
                    session.
                  </p>
                </div>
                <div className="actions-row">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() =>
                      void window.elmDesktop.toggleHostToolbarWindow(true)
                    }
                  >
                    Show Floating Toolbar
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() =>
                      void window.elmDesktop.openSeparateChatWindow()
                    }
                  >
                    Open Private Chat
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void window.elmDesktop.minimizeWindow()}
                  >
                    Minimize Window
                  </button>
                  <button
                    type="button"
                    data-testid="host-card-end-session"
                    className="danger-btn"
                    onClick={handleDisconnectSession}
                  >
                    End Session
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* FULL-AREA ACTIVE SESSION VIEWER (VIEWER / GUEST ONLY) */}
          {snapshot?.activeSession && webrtcSnap && !isLocalHost && (
            <section
              ref={viewerViewportRef}
              className="active-viewer-viewport"
              data-testid="active-viewer-stage"
            >
                <div
                  ref={viewerContainerRef}
                  className={`viewer-stage-container ${
                    viewerMode === 'fit' ? 'fit-mode' : 'actual-mode'
                  }`}
                >
                  <video
                    ref={guestVideoRef}
                    autoPlay
                    playsInline
                    muted
                    onResize={handleVideoResize}
                    onLoadedMetadata={handleVideoResize}
                    className={
                      viewerMode === 'fit'
                        ? 'stage-video-fit'
                        : 'stage-video-actual'
                    }
                    style={
                      webrtcSnap.guestVideoTracksCount === 0 ||
                      webrtcSnap.guestPlayback.videoPausedLocally
                        ? { display: 'none' }
                        : viewerMode === 'actual' &&
                          renderedDimensions &&
                          renderedDimensions.videoWidth > 0
                        ? {
                            width: `${Math.round(
                              renderedDimensions.videoWidth /
                                (window.devicePixelRatio || 1)
                            )}px`,
                            height: `${Math.round(
                              renderedDimensions.videoHeight /
                                (window.devicePixelRatio || 1)
                            )}px`,
                          }
                        : undefined
                    }
                  />
                  {webrtcSnap.guestVideoTracksCount === 0 && stageStatus && (
                    <div
                      className="viewer-stage-empty-placeholder muted"
                      data-testid="guest-session-placeholder"
                      style={{ padding: '40px 20px', textAlign: 'center' }}
                    >
                      <strong style={{ display: 'block', marginBottom: '6px' }}>
                        {stageStatus.headline}
                      </strong>
                      <span>{stageStatus.detail}</span>
                    </div>
                  )}
                  {webrtcSnap.guestVideoTracksCount > 0 &&
                    webrtcSnap.guestPlayback.videoPausedLocally && (
                      <div
                        className="viewer-paused-overlay"
                        data-testid="viewer-screen-hidden-overlay"
                      >
                        Remote screen hidden locally. Host sharing and chat remain active.
                      </div>
                    )}
                </div>

              {/* Hidden audio elements for remote mic & device sound (Viewer only) */}
              <audio ref={guestMicAudioRef} autoPlay />
              <audio ref={guestDeviceAudioRef} autoPlay />

              {/* ONE FLOATING PANEL ASSEMBLY (VIEWER) */}
              <div
                className="floating-panel-assembly"
                data-testid="floating-viewer-panel"
                style={{
                  left: `${panelLayout.x}px`,
                  top: `${panelLayout.y}px`,
                }}
              >
                <div
                  className="floating-panel-main"
                  style={{ width: `${panelLayout.width}px` }}
                >
                  {/* COMPACT FLOATING BAR */}
                  <div
                    className="floating-panel-bar"
                    data-testid="floating-panel-bar"
                    style={{
                      backgroundColor: buildBackgroundRgba(
                        themeState.mode,
                        panelAppearance.barBgOpacity
                      ),
                      fontSize: `${panelAppearance.barTextSizePx}px`,
                    }}
                  >
                      <button
                        type="button"
                        className="floating-drag-handle"
                        data-testid="floating-panel-drag-handle"
                        aria-label="Drag floating panel"
                        title="Drag panel"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          panelInteractionRef.current = {
                            kind: 'drag',
                            startX: e.clientX,
                            startY: e.clientY,
                            initial: panelLayout,
                          };
                        }}
                      >
                        ⋮⋮
                      </button>

                    <span
                      className={`presence-pill ${transportStatus?.tone ?? 'pending'}`}
                      data-testid="floating-transport-status"
                    >
                      {transportStatus?.label ?? 'Connecting'}
                    </span>

                        <button
                          type="button"
                          className={
                            viewerMode === 'fit'
                              ? 'mode-toggle-btn active'
                              : 'mode-toggle-btn'
                          }
                          onClick={() => setViewerMode('fit')}
                        >
                          Fit
                        </button>
                        <button
                          type="button"
                          className={
                            viewerMode === 'actual'
                              ? 'mode-toggle-btn active'
                              : 'mode-toggle-btn'
                          }
                          onClick={() => setViewerMode('actual')}
                        >
                          1:1
                        </button>

                    <button
                      type="button"
                      data-testid="floating-chat-toggle"
                      className={
                        floatingChatOpen
                          ? 'small-secondary-btn active'
                          : 'small-secondary-btn'
                      }
                      onClick={() =>
                        setFloatingChatOpen((prev) => {
                          const next = !prev;
                          if (next) {
                            setFloatingSettingsOpen(false);
                            setHostSourcePickerOpen(false);
                          }
                          return next;
                        })
                      }
                    >
                      Chat
                      {hasUnreadChat && (
                        <span
                          className="chat-unread-dot"
                          data-testid="chat-unread-dot"
                          aria-hidden="true"
                        />
                      )}
                    </button>

                    <button
                      ref={floatingSettingsToggleRef}
                      type="button"
                      data-testid="floating-settings-toggle"
                      className={
                        floatingSettingsOpen
                          ? 'small-secondary-btn active'
                          : 'small-secondary-btn'
                      }
                      onClick={() =>
                        setFloatingSettingsOpen((prev) => {
                          const next = !prev;
                          if (next) {
                            setHostSourcePickerOpen(false);
                          }
                          return next;
                        })
                      }
                    >
                      Settings
                    </button>

                    {!isLocalHost && (
                      <>
                        <span
                          className="floating-toolbar-divider"
                          aria-hidden="true"
                        />
                        <button
                          type="button"
                          data-testid="toolbar-my-mic-btn"
                          className={
                            webrtcSnap.viewerMicActive
                              ? 'toolbar-icon-btn active'
                              : 'toolbar-icon-btn'
                          }
                          aria-pressed={webrtcSnap.viewerMicActive}
                          title={
                            webrtcSnap.viewerMicActive
                              ? 'Your microphone is ON. Click to turn OFF.'
                              : 'Your microphone is OFF. Click to turn ON.'
                          }
                          aria-label={
                            webrtcSnap.viewerMicActive
                              ? 'Turn off my microphone'
                              : 'Turn on my microphone'
                          }
                          onClick={() => void handleToggleViewerMic()}
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
                            {webrtcSnap.viewerMicActive ? (
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

                        <button
                          type="button"
                          data-testid="toolbar-peer-mic-btn"
                          className={
                            hasGuestMicTrack &&
                            !webrtcSnap.guestPlayback.micMutedLocally
                              ? 'toolbar-icon-btn active'
                              : hasGuestMicTrack
                              ? 'toolbar-icon-btn muted-state'
                              : 'toolbar-icon-btn'
                          }
                          disabled={!hasGuestMicTrack}
                          title={
                            !hasGuestMicTrack
                              ? 'Peer microphone not shared'
                              : webrtcSnap.guestPlayback.micMutedLocally
                              ? 'Unmute peer microphone'
                              : 'Mute peer microphone'
                          }
                          aria-label="Peer microphone"
                          onClick={() =>
                            webrtcControllerRef.current?.updateGuestLocalPlayback(
                              {
                                micMutedLocally:
                                  !webrtcSnap.guestPlayback.micMutedLocally,
                              }
                            )
                          }
                        >
                          {hasGuestMicTrack &&
                          !webrtcSnap.guestPlayback.micMutedLocally ? (
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
                              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                            </svg>
                          ) : (
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
                              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                              <line x1="22" y1="9" x2="16" y2="15" />
                              <line x1="16" y1="9" x2="22" y2="15" />
                            </svg>
                          )}
                        </button>

                        <button
                          type="button"
                          data-testid="toolbar-peer-sound-btn"
                          className={
                            hasGuestDeviceAudioTrack &&
                            !webrtcSnap.guestPlayback.deviceAudioMutedLocally
                              ? 'toolbar-icon-btn active'
                              : hasGuestDeviceAudioTrack
                              ? 'toolbar-icon-btn muted-state'
                              : 'toolbar-icon-btn'
                          }
                          disabled={!hasGuestDeviceAudioTrack}
                          title={
                            !hasGuestDeviceAudioTrack
                              ? 'Peer device sound not shared'
                              : webrtcSnap.guestPlayback.deviceAudioMutedLocally
                              ? 'Unmute peer device sound'
                              : 'Mute peer device sound'
                          }
                          aria-label="Peer device sound"
                          onClick={() =>
                            webrtcControllerRef.current?.updateGuestLocalPlayback(
                              {
                                deviceAudioMutedLocally:
                                  !webrtcSnap.guestPlayback
                                    .deviceAudioMutedLocally,
                              }
                            )
                          }
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
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          </svg>
                        </button>

                        <button
                          type="button"
                          data-testid="toolbar-peer-screen-btn"
                          className={
                            webrtcSnap.guestVideoTracksCount > 0 &&
                            !webrtcSnap.guestPlayback.videoPausedLocally
                              ? 'toolbar-icon-btn active'
                              : webrtcSnap.guestVideoTracksCount > 0
                              ? 'toolbar-icon-btn muted-state'
                              : 'toolbar-icon-btn'
                          }
                          disabled={webrtcSnap.guestVideoTracksCount === 0}
                          title={
                            webrtcSnap.guestVideoTracksCount === 0
                              ? 'Waiting for Host to share screen'
                              : webrtcSnap.guestPlayback.videoPausedLocally
                              ? 'Show remote screen'
                              : 'Hide remote screen locally'
                          }
                          aria-label="Peer screen"
                          onClick={() =>
                            webrtcControllerRef.current?.updateGuestLocalPlayback(
                              {
                                videoPausedLocally:
                                  !webrtcSnap.guestPlayback.videoPausedLocally,
                              }
                            )
                          }
                        >
                          {webrtcSnap.guestVideoTracksCount > 0 &&
                          !webrtcSnap.guestPlayback.videoPausedLocally ? (
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
                              <line x1="8" y1="21" x2="16" y2="21" />
                              <line x1="12" y1="17" x2="12" y2="21" />
                            </svg>
                          ) : (
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
                              <path d="M17 17H4a2 2 0 0 1-2-2V5c0-1.5 1-2 1-2" />
                              <path d="M22 15V5a2 2 0 0 0-2-2H9" />
                              <path d="M8 21h8" />
                              <path d="M12 17v4" />
                              <path d="m2 2 20 20" />
                            </svg>
                          )}
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      data-testid="floating-end-session"
                      className="danger-btn"
                      title="End session"
                      onClick={handleDisconnectSession}
                    >
                      End Session
                    </button>
                  </div>

                  {/* VIEWER MIC CONSENT PROMPT WHEN HOST CLICKS PEER MIC */}
                  {!isLocalHost && webrtcSnap.viewerMicRequestPending && (
                    <div
                      className="floating-panel-chat"
                      data-testid="viewer-mic-request-banner"
                      style={{
                        backgroundColor: buildBackgroundRgba(
                          themeState.mode,
                          panelAppearance.chatBgOpacity
                        ),
                        padding: '10px 12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                      }}
                    >
                      <span style={{ fontSize: '0.82rem' }}>
                        Host is asking to turn on your microphone.
                      </span>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          data-testid="viewer-mic-allow-btn"
                          className="primary-btn"
                          style={{ height: '28px', padding: '0 10px', fontSize: '0.78rem' }}
                          onClick={() =>
                            void webrtcControllerRef.current?.respondToViewerMicRequest(
                              true
                            )
                          }
                        >
                          Allow Mic
                        </button>
                        <button
                          type="button"
                          data-testid="viewer-mic-decline-btn"
                          className="small-secondary-btn"
                          onClick={() =>
                            void webrtcControllerRef.current?.respondToViewerMicRequest(
                              false
                            )
                          }
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  )}

                  {/* EXPANDED CHAT DIRECTLY BELOW THE SAME BAR (NO SECOND TITLE BAR) */}
                  {floatingChatOpen && (
                    <div
                      className="floating-panel-chat"
                      data-testid="floating-panel-chat"
                      style={{
                        backgroundColor: buildBackgroundRgba(
                          themeState.mode,
                          panelAppearance.chatBgOpacity
                        ),
                        fontSize: `${panelAppearance.chatTextSizePx}px`,
                        height: `${panelLayout.chatHeight}px`,
                      }}
                    >
                      <div
                        className="muted"
                        data-testid="floating-chat-status"
                        style={{ fontSize: '0.75rem' }}
                      >
                        {chatStatus?.label ?? 'Chat Offline'}
                      </div>
                      <div
                        className="floating-chat-messages"
                        ref={viewerChatScrollRef}
                      >
                        {webrtcSnap.messages.length === 0 ? (
                          <div className="muted">
                            In-memory session chat. Cleared on End Session.
                          </div>
                        ) : (
                          webrtcSnap.messages.map((m) => {
                            const imgUrl =
                              webrtcSnap.imageAttachmentsByMessageId[
                                m.messageId
                              ] ?? inMemoryImagesByMsgId[m.messageId];
                            const isMine =
                              m.senderAccountId === account?.accountId;
                            const status = isMine
                              ? webrtcSnap.messageStatusesById[m.messageId] ??
                                'sent'
                              : null;
                            return (
                              <div
                                key={m.messageId}
                                data-message-id={m.messageId}
                                data-incoming={isMine ? 'false' : 'true'}
                                className={`chat-bubble ${
                                  isMine ? 'chat-mine' : 'chat-theirs'
                                }`}
                              >
                                {!isMine && (
                                  <div className="chat-meta">
                                    <strong>{m.senderDisplayName}</strong>
                                  </div>
                                )}
                                {m.text && (
                                  <div className="chat-text">{m.text}</div>
                                )}
                                {imgUrl && (
                                  <img
                                    src={imgUrl}
                                    alt="In-memory shared attachment"
                                    className="in-memory-image-preview"
                                  />
                                )}
                                <div className="chat-bubble-footer">
                                  <span className="chat-timestamp">
                                    {new Date(m.sentAt).toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}
                                  </span>
                                  {status && (
                                    <span
                                      className={`chat-status-ticks ${status}`}
                                      data-testid={`chat-status-${m.messageId}`}
                                      data-status={status}
                                      aria-label={`Message status: ${status}`}
                                    >
                                      {status === 'sent' ? '✓' : '✓✓'}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
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

                      <form
                        className="chat-input-row"
                        onSubmit={handleSendChatFromAnyWindow}
                      >
                        <input
                          ref={imageFileInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          style={{ display: 'none' }}
                          onChange={handleAttachInMemoryImage}
                        />
                        <button
                          type="button"
                          className="small-secondary-btn"
                          onClick={() => imageFileInputRef.current?.click()}
                          title="Attach an image in memory for this session only"
                        >
                          Attach Image
                        </button>
                        <input
                          type="text"
                          className="code-input chat-text-input"
                          placeholder="Type a message..."
                          value={chatInputText}
                          onChange={(e) => setChatInputText(e.target.value)}
                        />
                        <button type="submit" className="primary-btn">
                          Send
                        </button>
                      </form>

                      {/* Width + Height resize handle when chat is expanded */}
                      <div
                        className="floating-resize-corner"
                        data-testid="floating-resize-both"
                        title="Resize panel width and chat height"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          panelInteractionRef.current = {
                            kind: 'resize-both',
                            startX: e.clientX,
                            startY: e.clientY,
                            initial: panelLayout,
                          };
                        }}
                      />
                    </div>
                  )}

                  {/* Width resize handle (available in compact and expanded modes) */}
                  <div
                    className="floating-resize-edge"
                    data-testid="floating-resize-width"
                    title="Resize panel width"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      panelInteractionRef.current = {
                        kind: 'resize-width',
                        startX: e.clientX,
                        startY: e.clientY,
                        initial: panelLayout,
                      };
                    }}
                  />
                </div>

                {/* ATTACHED RIGHT SIDEBAR (CLOSES ON OUTSIDE CLICK OR ESCAPE) */}
                {floatingSettingsOpen && (
                  <aside
                    ref={floatingSettingsSidebarRef}
                    className="floating-settings-sidebar"
                    data-testid="floating-settings-sidebar"
                    style={{
                      backgroundColor: buildBackgroundRgba(
                        themeState.mode,
                        panelAppearance.barBgOpacity
                      ),
                    }}
                  >
                    <div className="sidebar-section">
                      <strong>Appearance</strong>
                      <div className="sidebar-row">
                        <span>Theme</span>
                        <ThemeToggleButton
                          themeState={themeState}
                          onToggle={() => void handleToggleTheme()}
                        />
                      </div>

                      <label className="sidebar-slider">
                        <span>
                          Bar Opacity:{' '}
                          {Math.round(panelAppearance.barBgOpacity * 100)}%
                        </span>
                        <input
                          type="range"
                          min={0.35}
                          max={1}
                          step={0.05}
                          value={panelAppearance.barBgOpacity}
                          onChange={(e) =>
                            updateViewerAppearance({
                              barBgOpacity: Number(e.target.value),
                            })
                          }
                        />
                      </label>

                      <label className="sidebar-slider">
                        <span>
                          Chat Opacity:{' '}
                          {Math.round(panelAppearance.chatBgOpacity * 100)}%
                        </span>
                        <input
                          type="range"
                          min={0.35}
                          max={1}
                          step={0.05}
                          value={panelAppearance.chatBgOpacity}
                          onChange={(e) =>
                            updateViewerAppearance({
                              chatBgOpacity: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    </div>

                    <div className="sidebar-section">
                      <strong>Presentation View</strong>
                      <button
                        type="button"
                        data-testid="open-presentation-view-button"
                        className="secondary-btn"
                        onClick={() =>
                          void window.elmDesktop.openPresentationView()
                        }
                      >
                        Open Video-Only Window
                      </button>
                      <p className="muted" style={{ fontSize: '0.75rem' }}>
                        Excludes the floating panel only when sharing that
                        selected Presentation View window. Normal viewer or
                        entire-display shares include the panel.
                      </p>
                    </div>

                    {metadata.devModeEnabled && (
                      <div className="sidebar-section">
                        <button
                          type="button"
                          className="small-secondary-btn"
                          onClick={() => setOptInDiagnostics((prev) => !prev)}
                        >
                          {optInDiagnostics
                            ? 'Hide Diagnostics'
                            : 'Show Diagnostics'}
                        </button>
                        {optInDiagnostics && liveDiagnostics && (
                          <div className="muted" style={{ fontSize: '0.72rem' }}>
                            <div>
                              Decoded: {liveDiagnostics.decodedWidth ?? 0}×
                              {liveDiagnostics.decodedHeight ?? 0} @{' '}
                              {liveDiagnostics.decodedFps ?? 0}fps
                            </div>
                            <div>
                              Out Frames: {liveDiagnostics.outboundFramesSent ?? 0}{' '}
                              | In Bytes: {liveDiagnostics.inboundBytesReceived ?? 0}{' '}
                              | Dec Frames: {liveDiagnostics.inboundFramesDecoded ?? 0}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </aside>
                )}
              </div>
            </section>
          )}

          {/* INCOMING REQUEST DIALOG (USER A) */}
          {snapshot && snapshot.incomingInvites.length > 0 && (() => {
            const activeInvite = snapshot.incomingInvites[0];
            const isReverseInvite = activeInvite.intent === 'invite';
            return (
              <section
                className="card card-full card-incoming-invite"
                role="dialog"
                aria-modal="true"
                aria-labelledby="incoming-request-headline"
                data-testid="incoming-request-dialog"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    void handleRespondToInvite(activeInvite, 'decline');
                  }
                }}
              >
                <div className="subcard-header">
                  <div>
                    <h2 id="incoming-request-headline">
                      {formatIncomingRequestHeadline(activeInvite)}
                    </h2>
                    <p className="muted" style={{ marginTop: '4px' }}>
                      Device Code:{' '}
                      <code data-testid="incoming-requester-code">
                        {activeInvite.requesterFriendCode}
                      </code>
                    </p>
                  </div>
                  {metadata.devModeEnabled && (
                    <span className="badge badge-neutral">
                      Invite: {activeInvite.inviteId}
                    </span>
                  )}
                </div>

                {isReverseInvite ? (
                  <div className="subcard" data-testid="incoming-viewer-notice">
                    <p className="muted">
                      You are invited to view{' '}
                      <strong>{activeInvite.requesterDisplayName}</strong>&apos;s
                      screen. Nothing is shared until the host clicks{' '}
                      <strong>Start Sharing</strong>.
                    </p>
                  </div>
                ) : (
                  <div className="toggle-bar">
                    <label
                      className={`permission-toggle-card ${
                        preAcceptMedia.screenVideo ? 'checked' : ''
                      }`}
                    >
                      <span className="checkbox-label">
                        <input
                          type="checkbox"
                          autoFocus
                          checked={preAcceptMedia.screenVideo}
                          onChange={(e) =>
                            setPreAcceptMedia((prev) => ({
                              ...prev,
                              screenVideo: e.target.checked,
                            }))
                          }
                        />
                        <span>Screen</span>
                      </span>
                      <span
                        className={`presence-pill ${
                          preAcceptMedia.screenVideo ? 'online' : 'offline'
                        }`}
                      >
                        {preAcceptMedia.screenVideo ? 'ON' : 'OFF'}
                      </span>
                    </label>

                    <label
                      className={`permission-toggle-card ${
                        preAcceptMedia.microphoneAudio ? 'checked' : ''
                      }`}
                    >
                      <span className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={preAcceptMedia.microphoneAudio}
                          onChange={(e) =>
                            setPreAcceptMedia((prev) => ({
                              ...prev,
                              microphoneAudio: e.target.checked,
                            }))
                          }
                        />
                        <span>Microphone</span>
                      </span>
                      <span
                        className={`presence-pill ${
                          preAcceptMedia.microphoneAudio ? 'online' : 'offline'
                        }`}
                      >
                        {preAcceptMedia.microphoneAudio ? 'ON' : 'OFF'}
                      </span>
                    </label>

                    <label
                      className={`permission-toggle-card ${
                        preAcceptMedia.deviceAudio ? 'checked' : ''
                      }`}
                    >
                      <span className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={preAcceptMedia.deviceAudio}
                          onChange={(e) =>
                            setPreAcceptMedia((prev) => ({
                              ...prev,
                              deviceAudio: e.target.checked,
                            }))
                          }
                        />
                        <span>Device Sound</span>
                      </span>
                      <span
                        className={`presence-pill ${
                          preAcceptMedia.deviceAudio ? 'online' : 'offline'
                        }`}
                      >
                        {preAcceptMedia.deviceAudio ? 'ON' : 'OFF'}
                      </span>
                    </label>
                  </div>
                )}

                <div className="actions-row" style={{ marginTop: '14px' }}>
                  <button
                    type="button"
                    data-testid="incoming-decline-button"
                    className="danger-btn"
                    onClick={() => handleRespondToInvite(activeInvite, 'decline')}
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    data-testid="incoming-accept-button"
                    className="primary-btn"
                    autoFocus={isReverseInvite}
                    onClick={() => handleRespondToInvite(activeInvite, 'accept')}
                  >
                    Accept
                  </button>
                </div>
              </section>
            );
          })()}

          {/* SIMPLIFIED SINGLE-WINDOW HOME INTERFACE */}
          {!snapshot?.activeSession && (
            <div className="home-stack" data-testid="home-dashboard">
              <section className="card home-connect-row">
                <form className="connect-bar" onSubmit={handleSendInvite}>
                  <input
                    id="connect-friend-code-input"
                    type="text"
                    data-testid="connect-friend-code-input"
                    className="code-input friend-code-input connect-bar-input"
                    placeholder="Enter a friend's device code..."
                    aria-label="Enter a friend's device code"
                    value={enteredFriendCode}
                    onChange={(e) =>
                      setEnteredFriendCode(e.target.value.toUpperCase())
                    }
                    disabled={!account}
                    maxLength={13}
                  />
                  <button
                    type="submit"
                    data-testid="send-connect-request-button"
                    className="primary-btn"
                    disabled={
                      !account ||
                      submittingRequest ||
                      Boolean(snapshot?.outgoingInvite) ||
                      !enteredFriendCode.trim()
                    }
                  >
                    {submittingRequest ? 'Sending...' : 'Send Request'}
                  </button>
                </form>

                {snapshot?.outgoingInvite && (() => {
                  const outgoing = snapshot.outgoingInvite;
                  const remainingMs = outgoing.expiresAt
                    ? Math.max(0, Date.parse(outgoing.expiresAt) - nowTickMs)
                    : INVITE_TIMEOUT_MS;
                  const waitingPeerName = resolveWaitingPeerName(
                    outgoing.targetFriendCode,
                    outgoing.targetDisplayName,
                    recentPeers
                  );
                  return (
                    <div
                      className="subcard waiting-approval-card"
                      data-testid="waiting-for-approval-card"
                    >
                      <h3>Waiting for Approval</h3>
                      <p className="waiting-friend-line">
                        Friend: <strong>{waitingPeerName}</strong>
                      </p>
                      <code className="waiting-code-line">
                        {outgoing.targetFriendCode}
                      </code>
                      <p className="waiting-expiry-line muted">
                        Expires in{' '}
                        <strong data-testid="outgoing-invite-countdown">
                          {formatCountdownMmSs(remainingMs)}
                        </strong>
                      </p>
                      <button
                        type="button"
                        data-testid="cancel-outgoing-invite-button"
                        className="danger-btn"
                        disabled={cancellingInviteId === outgoing.inviteId}
                        onClick={() => void handleCancelOutgoingInvite(outgoing.inviteId)}
                      >
                        {cancellingInviteId === outgoing.inviteId
                          ? 'Cancelling...'
                          : 'Cancel Request'}
                      </button>
                    </div>
                  );
                })()}
              </section>

              {requestOutcomeModal && (
                <section
                  className="card request-outcome-card"
                  role="alertdialog"
                  aria-modal="true"
                  data-testid="request-outcome-modal"
                >
                  <h3>
                    {requestOutcomeModal.kind === 'offline'
                      ? 'Friend Offline'
                      : 'Request Expired'}
                  </h3>
                  {requestOutcomeModal.kind === 'offline' ? (
                    <>
                      <p className="muted">This desk is not available.</p>
                      <p className="muted">
                        Please make sure Elm-AnyDesk is running on the remote
                        device and that it is connected to the internet.
                      </p>
                    </>
                  ) : (
                    <p className="muted">
                      No response was received from{' '}
                      <code>{requestOutcomeModal.friendCode}</code> before the{' '}
                      {Math.round(INVITE_TIMEOUT_MS / 1000)}-second request
                      timer expired.
                    </p>
                  )}
                  <div className="actions-row" style={{ marginTop: '12px' }}>
                    <button
                      type="button"
                      data-testid="request-outcome-retry-button"
                      className="primary-btn"
                      disabled={submittingRequest}
                      onClick={() => {
                        if (requestOutcomeModal.inviteId) {
                          const dismissedId = requestOutcomeModal.inviteId;
                          setDismissedExpiredInviteIds((prev) => ({
                            ...prev,
                            [dismissedId]: true,
                          }));
                        }
                        void submitInviteRequest({
                          friendCode: requestOutcomeModal.friendCode,
                          intent: requestOutcomeModal.intent,
                          hostMediaSelection: requestOutcomeModal.hostMediaSelection,
                        });
                      }}
                    >
                      {submittingRequest ? 'Retrying...' : 'Retry'}
                    </button>
                    <button
                      type="button"
                      data-testid="request-outcome-close-button"
                      className="secondary-btn"
                      onClick={() => {
                        if (requestOutcomeModal.inviteId) {
                          const dismissedId = requestOutcomeModal.inviteId;
                          setDismissedExpiredInviteIds((prev) => ({
                            ...prev,
                            [dismissedId]: true,
                          }));
                        }
                        setRequestOutcomeModal(null);
                      }}
                    >
                      Close
                    </button>
                  </div>
                </section>
              )}

              {inviteDialogOpen && (
                <section
                  className="card invite-dialog-card"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="direct-invite-heading"
                  data-testid="direct-invite-dialog"
                >
                  <div className="subcard-header">
                    <div>
                      <h2 id="direct-invite-heading">
                        Invite a Friend to View Your Screen
                      </h2>
                      <p className="muted" style={{ marginTop: '4px' }}>
                        Send a reverse screen-share invitation. Once accepted, you
                        choose a window or display and click Start Sharing.
                      </p>
                    </div>
                  </div>

                  <form
                    className="invite-dialog-form"
                    onSubmit={handleSendReverseInvite}
                  >
                    <div className="setup-field">
                      <label htmlFor="invite-target-code">
                        Friend&apos;s Device Code
                      </label>
                      <input
                        id="invite-target-code"
                        type="text"
                        data-testid="invite-target-code-input"
                        className="code-input friend-code-input"
                        placeholder="ELM-XXXX-XXXX"
                        value={inviteTargetCode}
                        onChange={(e) =>
                          setInviteTargetCode(e.target.value.toUpperCase())
                        }
                        maxLength={13}
                        required
                      />
                    </div>

                    <div className="toggle-bar">
                      <label
                        className={`permission-toggle-card ${
                          inviteHostMedia.screenVideo ? 'checked' : ''
                        }`}
                      >
                        <span className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={inviteHostMedia.screenVideo}
                            onChange={(e) =>
                              setInviteHostMedia((prev) => ({
                                ...prev,
                                screenVideo: e.target.checked,
                              }))
                            }
                          />
                          <span>Screen</span>
                        </span>
                        <span
                          className={`presence-pill ${
                            inviteHostMedia.screenVideo ? 'online' : 'offline'
                          }`}
                        >
                          {inviteHostMedia.screenVideo ? 'ON' : 'OFF'}
                        </span>
                      </label>

                      <label
                        className={`permission-toggle-card ${
                          inviteHostMedia.microphoneAudio ? 'checked' : ''
                        }`}
                      >
                        <span className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={inviteHostMedia.microphoneAudio}
                            onChange={(e) =>
                              setInviteHostMedia((prev) => ({
                                ...prev,
                                microphoneAudio: e.target.checked,
                              }))
                            }
                          />
                          <span>Microphone</span>
                        </span>
                        <span
                          className={`presence-pill ${
                            inviteHostMedia.microphoneAudio ? 'online' : 'offline'
                          }`}
                        >
                          {inviteHostMedia.microphoneAudio ? 'ON' : 'OFF'}
                        </span>
                      </label>

                      <label
                        className={`permission-toggle-card ${
                          inviteHostMedia.deviceAudio ? 'checked' : ''
                        }`}
                      >
                        <span className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={inviteHostMedia.deviceAudio}
                            onChange={(e) =>
                              setInviteHostMedia((prev) => ({
                                ...prev,
                                deviceAudio: e.target.checked,
                              }))
                            }
                          />
                          <span>Device Sound</span>
                        </span>
                        <span
                          className={`presence-pill ${
                            inviteHostMedia.deviceAudio ? 'online' : 'offline'
                          }`}
                        >
                          {inviteHostMedia.deviceAudio ? 'ON' : 'OFF'}
                        </span>
                      </label>
                    </div>

                    <div className="actions-row" style={{ marginTop: '12px' }}>
                      <button
                        type="submit"
                        data-testid="send-direct-invite-button"
                        className="primary-btn"
                        disabled={
                          submittingRequest ||
                          !inviteTargetCode.trim() ||
                          Boolean(snapshot?.outgoingInvite)
                        }
                      >
                        {submittingRequest ? 'Sending...' : 'Send Invite'}
                      </button>
                      <button
                        type="button"
                        data-testid="copy-invitation-snippet-button"
                        className="secondary-btn"
                        disabled={!account}
                        onClick={() => void handleCopyInvitationSnippet()}
                      >
                        {copiedInvitation ? 'Copied!' : 'Copy Invitation'}
                      </button>
                      <button
                        type="button"
                        data-testid="cancel-invite-dialog-button"
                        className="secondary-btn"
                        onClick={() => setInviteDialogOpen(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </section>
              )}

              <section
                className="card recent-sessions-card"
                data-testid="recent-sessions-section"
              >
                <div className="subcard-header">
                  <div>
                    <h2>Recent Sessions</h2>
                    <p className="muted">
                      Favorites stay pinned first; saved only on this device.
                    </p>
                  </div>
                  <div
                    className="recent-view-toggle"
                    role="group"
                    aria-label="Recent sessions view mode"
                  >
                    <button
                      type="button"
                      data-testid="recent-view-grid"
                      className={`small-secondary-btn ${
                        recentViewMode === 'grid' ? 'active-view-btn' : ''
                      }`}
                      onClick={() => setRecentViewMode('grid')}
                    >
                      Grid
                    </button>
                    <button
                      type="button"
                      data-testid="recent-view-list"
                      className={`small-secondary-btn ${
                        recentViewMode === 'list' ? 'active-view-btn' : ''
                      }`}
                      onClick={() => setRecentViewMode('list')}
                    >
                      List
                    </button>
                  </div>
                </div>

                {recentPeers.length === 0 ? (
                  <p className="muted" data-testid="recent-sessions-empty">
                    No recent sessions yet. Connect or invite a friend to see them
                    here.
                  </p>
                ) : (
                  <div
                    className={
                      recentViewMode === 'grid'
                        ? 'recent-sessions-grid'
                        : 'recent-sessions-list'
                    }
                    data-testid="recent-sessions-grid"
                  >
                    {recentPeers.map((peer) => {
                      const onlineStatus = peerOnlineMap[peer.friendCode] ?? 'unknown';
                      const peerLabel = resolveRecentPeerDisplayName(peer);
                      const menuOpen = openPeerMenuCode === peer.friendCode;
                      const isRenaming = renamingPeerCode === peer.friendCode;

                      return (
                        <article
                          key={peer.friendCode}
                          className={`recent-peer-card ${
                            recentViewMode === 'list' ? 'list-row' : ''
                          }`}
                          data-testid={`recent-peer-card-${peer.friendCode}`}
                        >
                          <div className="peer-card-top">
                            <div className="peer-card-heading">
                              <button
                                type="button"
                                className={`peer-star-btn ${peer.favorite ? 'starred' : ''}`}
                                aria-label={
                                  peer.favorite
                                    ? `Remove ${peerLabel} from favorites`
                                    : `Add ${peerLabel} to favorites`
                                }
                                title={
                                  peer.favorite
                                    ? 'Remove from Favorites'
                                    : 'Add to Favorites'
                                }
                                onClick={() => {
                                  void window.elmDesktop
                                    .toggleFavoritePeer(peer.friendCode)
                                    .then((nextPeers) => {
                                      setRecentPeers(nextPeers);
                                    });
                                }}
                              >
                                {peer.favorite ? '★' : '☆'}
                              </button>
                              {!isRenaming && (
                                <strong className="peer-card-name">{peerLabel}</strong>
                              )}
                            </div>

                            <span
                              className={`peer-status-badge ${onlineStatus}`}
                              data-testid={`peer-status-${peer.friendCode}`}
                              title={
                                onlineStatus === 'online'
                                  ? 'Server confirmed online'
                                  : onlineStatus === 'offline'
                                    ? 'Server confirmed offline'
                                    : 'Presence unknown'
                              }
                            >
                              <span
                                className={`peer-status-dot ${onlineStatus}`}
                                aria-hidden="true"
                              />
                              <span className="peer-status-label">
                                {onlineStatus === 'online'
                                  ? 'Online'
                                  : onlineStatus === 'offline'
                                    ? 'Offline'
                                    : 'Unknown'}
                              </span>
                            </span>
                          </div>

                          {isRenaming ? (
                            <form
                              className="peer-rename-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void window.elmDesktop
                                  .renameRecentPeer({
                                    friendCode: peer.friendCode,
                                    alias: renameAliasInput,
                                  })
                                  .then((nextPeers) => {
                                    setRecentPeers(nextPeers);
                                    setRenamingPeerCode(null);
                                  });
                              }}
                            >
                              <input
                                type="text"
                                className="code-input"
                                value={renameAliasInput}
                                onChange={(e) => setRenameAliasInput(e.target.value)}
                                placeholder={peer.peerName?.trim() || 'Enter friend name'}
                                maxLength={60}
                                autoFocus
                              />
                              <div className="actions-row">
                                <button type="submit" className="small-secondary-btn">
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="small-secondary-btn"
                                  onClick={() => setRenamingPeerCode(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          ) : (
                            <div className="peer-card-body">
                              <code className="peer-card-code">{peer.friendCode}</code>
                              {(peer.email || peer.phone) && (
                                <div
                                  className="peer-card-contact"
                                  data-testid={`peer-card-contact-${peer.friendCode}`}
                                >
                                  {peer.email && (
                                    <span
                                      className="peer-card-contact-line"
                                      data-testid={`peer-card-email-${peer.friendCode}`}
                                      title={peer.email}
                                    >
                                      {peer.email}
                                    </span>
                                  )}
                                  {peer.phone && (
                                    <span
                                      className="peer-card-contact-line"
                                      data-testid={`peer-card-phone-${peer.friendCode}`}
                                      title={peer.phone}
                                    >
                                      {peer.phone}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          <div className="peer-card-footer">
                            <button
                              type="button"
                              className="small-secondary-btn"
                              disabled={
                                submittingRequest ||
                                Boolean(snapshot?.outgoingInvite) ||
                                Boolean(snapshot?.activeSession)
                              }
                              onClick={() => {
                                setOpenPeerMenuCode(null);
                                void submitInviteRequest({
                                  friendCode: peer.friendCode,
                                  intent: 'connect',
                                });
                              }}
                            >
                              Connect
                            </button>
                            <button
                              type="button"
                              className="small-secondary-btn"
                              disabled={Boolean(snapshot?.activeSession)}
                              onClick={() => {
                                setOpenPeerMenuCode(null);
                                setInviteTargetCode(peer.friendCode);
                                setInviteHostMedia({
                                  screenVideo: true,
                                  microphoneAudio: false,
                                  deviceAudio: false,
                                });
                                setInviteDialogOpen(true);
                              }}
                            >
                              Invite
                            </button>
                            <button
                              type="button"
                              className="peer-menu-trigger"
                              data-peer-menu-trigger={peer.friendCode}
                              aria-label={`Actions for ${peerLabel}`}
                              aria-haspopup="menu"
                              aria-expanded={menuOpen}
                              onClick={() =>
                                setOpenPeerMenuCode((prev) =>
                                  prev === peer.friendCode ? null : peer.friendCode
                                )
                              }
                            >
                              ⋮
                            </button>
                          </div>

                          {menuOpen && (
                            <div
                              className="peer-card-menu"
                              role="menu"
                              data-peer-menu={peer.friendCode}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenPeerMenuCode(null);
                                  void submitInviteRequest({
                                    friendCode: peer.friendCode,
                                    intent: 'connect',
                                  });
                                }}
                              >
                                Connect
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenPeerMenuCode(null);
                                  setInviteTargetCode(peer.friendCode);
                                  setInviteHostMedia({
                                    screenVideo: true,
                                    microphoneAudio: false,
                                    deviceAudio: false,
                                  });
                                  setInviteDialogOpen(true);
                                }}
                              >
                                Invite
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenPeerMenuCode(null);
                                  void window.elmDesktop.copyTextToClipboard(
                                    peer.friendCode
                                  );
                                  showToast(
                                    `Copied ${peer.friendCode} to clipboard.`
                                  );
                                }}
                              >
                                Copy Code
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenPeerMenuCode(null);
                                  void window.elmDesktop
                                    .toggleFavoritePeer(peer.friendCode)
                                    .then((nextPeers) => {
                                      setRecentPeers(nextPeers);
                                    });
                                }}
                              >
                                {peer.favorite
                                  ? 'Remove from Favorites'
                                  : 'Add to Favorites'}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenPeerMenuCode(null);
                                  setRenamingPeerCode(peer.friendCode);
                                  setRenameAliasInput(
                                    peer.alias.trim() || peer.peerName?.trim() || ''
                                  );
                                }}
                              >
                                Rename
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="danger-menu-item"
                                onClick={() => {
                                  setOpenPeerMenuCode(null);
                                  void window.elmDesktop
                                    .removeRecentPeer(peer.friendCode)
                                    .then((nextPeers) => {
                                      setRecentPeers(nextPeers);
                                    });
                                }}
                              >
                                Remove
                              </button>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}

      {metadata.devModeEnabled && (
        <>
          {/* 5-COMBINATION WEBRTC VERIFICATION RUNNER */}
          <section className="card card-full">
        <div className="subcard-header">
          <div>
            <h2>
              WebRTC 5-Combination Verification Suite (Video-Only, Mic-Only,
              Device-Only, Combined, Chat-Only)
            </h2>
            <p className="muted">
              Verifies received tracks on Guest B&apos;s RTCPeerConnection,
              confirming Device-Only never delivers video, unchecked tracks are
              never attached, Host A can stop each source independently, and
              private chat flows bidirectionally over a reliable DataChannel.
            </p>
          </div>
          <button
            type="button"
            className="primary-btn"
            disabled={runningMatrix}
            onClick={handleRunVerificationMatrix}
          >
            {runningMatrix
              ? 'Running 5-Mode Verification...'
              : 'Run All 5 WebRTC Session Combinations'}
          </button>
        </div>

        {matrixReport && (
          <div className="telemetry-grid">
            {Object.values(matrixReport).map((item) => (
              <div key={item.mode} className="subcard">
                <h3>Mode: {item.mode}</h3>
                <ul className="feature-list">
                  <li>
                    Before Start Sharing: Video=
                    <code>{item.tracksBeforeStartSharing.guestVideoTracks}</code>
                    , Audio=
                    <code>{item.tracksBeforeStartSharing.guestAudioTracks}</code>
                  </li>
                  <li>
                    After Start Sharing (Received on B): Video=
                    <code>
                      {item.guestReceivedAfterStartSharing.videoTracksCount}
                    </code>
                    , Audio=
                    <code>
                      {item.guestReceivedAfterStartSharing.audioTracksCount}
                    </code>{' '}
                    (Sources:{' '}
                    <code>
                      {item.guestReceivedAfterStartSharing.sources.join(', ') ||
                        'none'}
                    </code>
                    )
                  </li>
                  <li>
                    Total Video Tracks Ever Delivered to B:{' '}
                    <code>
                      {
                        item.guestReceivedAfterStartSharing
                          .totalVideoTracksEverDeliveredToGuest
                      }
                    </code>
                  </li>
                  <li>
                    DataChannel: <code>{item.dataChannel.state}</code> (ordered=
                    <code>{String(item.dataChannel.ordered)}</code>, msgs=
                    <code>
                      {item.dataChannel.bidirectionalMessagesDelivered}
                    </code>
                    )
                  </li>
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* PHASE 4 IDEMPOTENT TEARDOWN, LIVENESS & NON-RESUMABLE SESSION VERIFICATION SUITE */}
      <section className="card card-full">
        <div className="subcard-header">
          <div>
            <h2>
              Phase 4 — Unified Idempotent Teardown, Liveness Check & Non-Resumable
              Sessions Suite
            </h2>
            <p className="muted">
              Verifies Disconnect from A &amp; B, App Close from A &amp; B,
              Force Quit liveness detection (and that liveness threshold is not
              a session time limit), Internet Loss &amp; Recovery on A, B, and
              both sides, Sleep/Wake, Duplicate Teardown Idempotency, and
              Minimize/Restore during active sharing.
            </p>
          </div>
          <button
            type="button"
            className="primary-btn"
            disabled={runningPhase4}
            onClick={handleRunPhase4Suite}
          >
            {runningPhase4
              ? 'Running Phase 4 Suite...'
              : 'Run Phase 4 Teardown & Liveness Suite'}
          </button>
        </div>

        {phase4Report && (
          <div className="telemetry-grid">
            {[
              phase4Report.disconnectFromHostA,
              phase4Report.disconnectFromGuestB,
              phase4Report.appCloseFromHostA,
              phase4Report.appCloseFromGuestB,
              phase4Report.forceQuitAbruptLoss,
              phase4Report.internetLossAndRecoveryHostA,
              phase4Report.internetLossAndRecoveryGuestB,
              phase4Report.internetLossAndRecoveryBothSides,
              phase4Report.sleepAndWake,
              phase4Report.duplicateTeardownIdempotency,
            ].map((sc) => (
              <div key={sc.scenario} className="subcard">
                <h3>
                  {sc.scenario} ({sc.passed ? 'PASS' : 'FAIL'})
                </h3>
                <ul className="feature-list">
                  <li>
                    Reason: <code>{sc.reason}</code> (
                    <code>{sc.subReason}</code>) | Detection:{' '}
                    <code>{sc.detectionTimeMs}ms</code>
                  </li>
                  <li>
                    Tracks Stopped: <code>{sc.hostTracksStoppedCount}</code> |
                    Viewer Cleared: <code>{String(sc.guestViewerCleared)}</code>{' '}
                    | PCs Closed:{' '}
                    <code>{String(sc.peerConnectionsClosed)}</code>
                  </li>
                  {sc.staleEventRejectedWithCode && (
                    <li>
                      Stale Event Rejected:{' '}
                      <code>{sc.staleEventRejectedWithCode}</code> | Fresh
                      Session:{' '}
                      <code>
                        {String(
                          sc.newSessionIdAfterFreshInvite !== sc.oldSessionId
                        )}
                      </code>
                    </li>
                  )}
                  {sc.duplicateCallCount !== undefined && (
                    <li>
                      Duplicate Teardown Calls Handled Idempotently:{' '}
                      <code>{sc.duplicateCallCount}</code>
                    </li>
                  )}
                </ul>
              </div>
            ))}
            <div className="subcard">
              <h3>
                {phase4Report.minimizeAndRestoreDuringSharing.scenario} (
                {phase4Report.minimizeAndRestoreDuringSharing.passed
                  ? 'PASS'
                  : 'FAIL'}
                )
              </h3>
              <ul className="feature-list">
                <li>
                  Minimized Duration:{' '}
                  <code>
                    {
                      phase4Report.minimizeAndRestoreDuringSharing
                        .minimizedDurationMs
                    }
                    ms
                  </code>{' '}
                  (Liveness Threshold:{' '}
                  <code>
                    {
                      phase4Report.minimizeAndRestoreDuringSharing
                        .livenessTimeoutMs
                    }
                    ms
                  </code>
                  )
                </li>
                <li>
                  Stayed Connected While Minimized:{' '}
                  <code>
                    {String(
                      phase4Report.minimizeAndRestoreDuringSharing
                        .stayedConnectedWhileMinimized
                    )}
                  </code>{' '}
                  | Video/Audio Tracks:{' '}
                  <code>
                    {
                      phase4Report.minimizeAndRestoreDuringSharing
                        .guestVideoTracksWhileMinimized
                    }
                    /
                    {
                      phase4Report.minimizeAndRestoreDuringSharing
                        .guestAudioTracksWhileMinimized
                    }
                  </code>
                </li>
              </ul>
            </div>
          </div>
        )}
      </section>

      {/* COLLAPSIBLE WINDOWS 11 PROTOTYPE DRAWER */}
      <section className="card card-full">
        <div className="subcard-header">
          <h2>Windows 11 Taskbar / DWM Prototype Telemetry</h2>
          <div className="actions-row">
            <button
              type="button"
              className="small-secondary-btn"
              onClick={() => setShowPrototypeDrawer((v) => !v)}
            >
              {showPrototypeDrawer ? 'Hide Telemetry' : 'Show Telemetry'}
            </button>
            <button
              type="button"
              className="small-secondary-btn"
              onClick={handleRunMinimizeRestoreCycle}
            >
              Run Open → Minimize → Thumbnail → Restore Cycle
            </button>
          </div>
        </div>
        {showPrototypeDrawer && dwmTelemetry && (
          <div className="telemetry-grid">
            <div className="subcard">
              <h3>Win32 Taskbar State</h3>
              <ul className="feature-list">
                <li>
                  HWND: <code>{dwmTelemetry.hwndHex}</code> | skipTaskbar:{' '}
                  <code>{String(dwmTelemetry.skipTaskbarApplied)}</code>
                </li>
                <li>
                  DWM Force Iconic / Disallow Peek:{' '}
                  <code>
                    {dwmTelemetry.dwmAttributes.forceIconicRepresentation} /{' '}
                    {dwmTelemetry.dwmAttributes.disallowPeek}
                  </code>
                </li>
              </ul>
            </div>
          </div>
        )}
      </section>
        </>
      )}
      {toastState && (
        <div
          className={`bottom-center-toast ${
            toastState.variant === 'error' ? 'toast-error' : ''
          }`}
          role={toastState.variant === 'error' ? 'alert' : 'status'}
          aria-live={toastState.variant === 'error' ? 'assertive' : 'polite'}
          data-testid="bottom-center-toast"
        >
          {toastState.message}
        </div>
      )}
    </main>
  );
}
