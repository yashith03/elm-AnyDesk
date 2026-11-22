import React, { useEffect, useRef, useState } from 'react';
import {
  INVITE_TIMEOUT_MS,
  type AccountProfile,
  type HostMediaSelection,
  type InviteIntent,
  type InviteSummary,
  type MediaSourceKind,
  type PresenceStateSnapshot,
} from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  DeviceSetupState,
  PresenceRuntimeStatus,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  VolatileSessionUiState,
} from '../shared/bridge';
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
  ApprovedWebRtcSessionController,
  runAllWebRtcSessionVerificationMatrix,
  runPhase4LifecycleAndTeardownVerificationSuite,
  type Phase4VerificationSuiteReport,
  type SessionCombinationVerificationReport,
  type WebRtcReadabilityDiagnostics,
  type WebRtcSessionSnapshot,
} from './webrtc-session';

function ThemeToggleButton(props: {
  themeState: ThemeStateSnapshot;
  onToggle: () => void;
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
      title={`Current theme: ${isDark ? 'Dark' : 'Light'} (${
        props.themeState.source === 'system_default'
          ? 'System Default'
          : 'Saved Preference'
      }). Click or press Enter/Space to switch.`}
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
  const [playWasapiTestTone] = useState<boolean>(false);

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
  const [chatSenderRole, setChatSenderRole] = useState<'host' | 'guest'>('host');
  const [revealChatContentInWindow, setRevealChatContentInWindow] =
    useState<boolean>(false);

  // Guest B media element refs for local playback
  const guestVideoRef = useRef<HTMLVideoElement | null>(null);
  const guestMicAudioRef = useRef<HTMLAudioElement | null>(null);
  const guestDeviceAudioRef = useRef<HTMLAudioElement | null>(null);

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
      window.elmDesktop.getTaskbarDwmTelemetry().catch(() => null),
      window.elmDesktop.getThemeState().catch(() => null),
      window.elmDesktop.getRecentPeers().catch(() => [] as RecentPeerEntry[]),
      window.elmDesktop.isWindowMaximized().catch(() => false),
    ])
      .then(([meta, volatileState, dwm, initialTheme, peers, maximized]) => {
        if (!mounted) return;
        setMetadata(meta);
        setVolatileChatState(volatileState);
        setRecentPeers(Array.isArray(peers) ? peers : []);
        setIsWindowMaximized(Boolean(maximized));
        if (dwm) setDwmTelemetry(dwm);
        if (initialTheme) {
          setThemeState(initialTheme);
          applyThemeToDom(initialTheme.mode);
        }
      })
      .catch((err: unknown) => {
        if (mounted) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      });

    // Hydrate registration & server-confirmed presence sequentially (single-flight in main)
    // without blocking initial render or racing GET /presence/state against POST /presence/connect.
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
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    const unsubPresence = window.elmDesktop.onPresenceStatusUpdated(
      (nextRuntime) => {
        if (!mounted) return;
        setPresenceRuntime(nextRuntime);
        if (nextRuntime.snapshot) {
          setSnapshot(nextRuntime.snapshot);
        }
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

  const applyAuthoritativeSnapshot = (nextSnapshot: PresenceStateSnapshot) => {
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
      if (!cancelled && epoch === snapshotEpochRef.current && res.ok && res.data) {
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
          if (epoch === snapshotEpochRef.current && res.ok && res.data) {
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
        webrtcControllerRef.current.destroy();
        webrtcControllerRef.current = null;
      }
      clearGuestMediaElements();
      setFloatingChatOpen(false);
      setFloatingSettingsOpen(false);
      setWebrtcSnap(null);
      void window.elmDesktop.syncVolatileSessionUiState({
        session: null,
        currentAccount: account,
        connectionState: 'closed',
        dataChannelState: 'closed',
        messages: [],
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
      webrtcControllerRef.current.destroy();
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
        setWebrtcSnap(nextSnap);
        void window.elmDesktop.syncVolatileSessionUiState({
          session: nextSnap.teardownReceipt ? null : currentSession,
          currentAccount: account,
          connectionState: nextSnap.connectionState,
          dataChannelState: nextSnap.dataChannelState,
          messages: nextSnap.messages,
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
      // Cleanup on unmount
    };
  }, [activeSessionId, metadata?.windowRole]);

  // Listen in Main Window for chat outbound sends and Stop Sharing commands from the Separate Chat Window
  useEffect(() => {
    if (!metadata || metadata.windowRole !== 'main') return;

    const unsubChatSend = window.elmDesktop.onChatWindowOutboundSend(
      async ({ text, senderOverride }) => {
        const ctrl = webrtcControllerRef.current;
        if (!ctrl) return;
        const defaultRole =
          account?.accountId === ctrl.session.guestAccountId ? 'guest' : 'host';
        await ctrl.sendChatMessageOverDataChannel({
          sender: senderOverride ?? defaultRole,
          text,
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
  }, [metadata?.windowRole, account?.accountId]);

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
      webrtcControllerRef.current.destroy();
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
      applyAuthoritativeSnapshot(res.data.snapshot);
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
      applyAuthoritativeSnapshot(res.data.snapshot);
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
    applyAuthoritativeSnapshot(res.data.snapshot);
    if (action === 'accept' && res.data.session) {
      setStatusMessage(
        `Accepted invite from ${invite.requesterDisplayName}. Connecting peer session. Media will not start until you click "Start Sharing".`
      );
    } else {
      setStatusMessage(
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
    if (res.ok && res.data) {
      applyAuthoritativeSnapshot(res.data.snapshot);
    }
    setStatusMessage(
      'Session ended via unified idempotent teardown path: A\'s tracks stopped, peer connections & DataChannels closed, B\'s viewer cleared, and session permissions invalidated. Send a fresh invite to connect again.'
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

  const handleExplicitStartSharing = async () => {
    clearAlerts();
    const ctrl = webrtcControllerRef.current;
    if (!ctrl) return;
    setIsStartingShare(true);
    try {
      const nextSnap = await ctrl.startHostSharing({
        selectedSourceId,
        playWasapiTestTone,
      });
      const failedSource = Object.values(nextSnap.hostMediaState).find(
        (s) =>
          s.approved &&
          !s.active &&
          (s.status === 'permission_denied' ||
            s.status === 'unsupported' ||
            s.status === 'source_disappeared')
      );
      if (failedSource) {
        setErrorCode(failedSource.status.toUpperCase());
        setErrorMessage(failedSource.message);
        return;
      }
      if (nextSnap.hostMediaState.screenVideo.active) {
        setStatusMessage(nextSnap.hostMediaState.screenVideo.message);
      } else {
        setStatusMessage('Approved media sharing started.');
      }
    } catch (err) {
      setErrorCode('CAPTURE_ERROR');
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to start screen sharing.'
      );
    } finally {
      setIsStartingShare(false);
    }
  };

  const handleStopIndividualSource = async (source: MediaSourceKind) => {
    const ctrl = webrtcControllerRef.current;
    if (!ctrl) return;
    await ctrl.stopHostSource(source);
  };

  const handleStopAllSharing = async () => {
    const ctrl = webrtcControllerRef.current;
    if (!ctrl) return;
    await ctrl.stopAllHostSharing();
  };

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

    if (metadata?.windowRole === 'chat') {
      setChatInputText('');
      setPendingImageDataUrl(null);
      setPendingImageName(null);
      setPendingImageMimeType(null);
      setPendingImageByteLength(0);
      await window.elmDesktop.sendChatFromChatWindow({
        text,
        senderOverride: chatSenderRole,
      });
      return;
    }

    const ctrl = webrtcControllerRef.current;
    if (!ctrl) {
      setChatAttachmentError('No active session.');
      return;
    }
    const activeSender: 'host' | 'guest' =
      account?.accountId === ctrl.session.guestAccountId ? 'guest' : 'host';

    if (imageUrl && imageMime) {
      const result = ctrl.sendChatImageOverDataChannel({
        sender: activeSender,
        senderAccountId:
          account?.accountId ??
          (activeSender === 'host'
            ? ctrl.session.hostAccountId
            : ctrl.session.guestAccountId),
        senderDisplayName:
          account?.displayName ??
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
  // SEPARATE EPHEMERAL CHAT WINDOW (windowRole === 'chat')
  // ============================================================================
  if (metadata.windowRole === 'chat') {
    const activeSession = volatileChatState?.session ?? null;
    const hostMedia = volatileChatState?.hostMediaState ?? null;
    const messages = volatileChatState?.messages ?? [];
    const anySourceActive =
      Boolean(hostMedia?.screenVideo.active) ||
      Boolean(hostMedia?.microphoneAudio.active) ||
      Boolean(hostMedia?.deviceAudio.active);

    return (
      <main className="app-shell">
        <header className="top-bar">
          <div className="top-bar-left">
            <div className="top-bar-eyebrow">
              <span className="badge">
                Separate 1:1 Chat Window — Volatile DataChannel Only
              </span>
              <span className="badge badge-neutral">
                Theme: {themeState.mode.toUpperCase()}
              </span>
            </div>
            <h1>Elm-AnyDesk — Private Session Chat</h1>
            <p className="muted">
              Message previews disabled by default. Zero OS toast notifications.
              Zero disk/database persistence. Standard OS window (not hidden
              from entire-display capture).
            </p>
          </div>
          <div className="top-bar-right">
            {activeSession && (
              <button
                type="button"
                data-testid="top-bar-disconnect-button"
                className="danger-btn"
                onClick={handleDisconnectSession}
              >
                Disconnect Session
              </button>
            )}
            <ThemeToggleButton
              themeState={themeState}
              onToggle={() => void handleToggleTheme()}
            />
          </div>
        </header>

        {/* ACTIVE-SHARING INDICATORS & VISIBLE STOP CONTROL FOR HOST A IN CHAT WINDOW */}
        <section className="card card-full">
          <div className="subcard-header">
            <div>
              <h2>
                Active-Sharing Indicators (Host A){' '}
                <span
                  className={`presence-pill ${
                    anySourceActive ? 'online' : 'offline'
                  }`}
                >
                  {anySourceActive ? 'SHARING LIVE' : 'NO ACTIVE MEDIA TRACKS'}
                </span>
              </h2>
              <p className="muted">
                DataChannel State:{' '}
                <code>{volatileChatState?.dataChannelState ?? 'closed'}</code> |
                Session:{' '}
                <code>{activeSession?.sessionId ?? 'No active session'}</code>
              </p>
            </div>
            {activeSession && (
              <div className="actions-row">
                <button
                  type="button"
                  className="danger-btn"
                  disabled={!anySourceActive}
                  onClick={() =>
                    window.elmDesktop.requestHostStopSharingFromChatWindow(
                      'all'
                    )
                  }
                >
                  Stop All Sharing (Host A)
                </button>
              </div>
            )}
          </div>

          {hostMedia && (
            <div className="telemetry-grid">
              {(
                ['screenVideo', 'microphoneAudio', 'deviceAudio'] as const
              ).map((src) => {
                const desc = hostMedia[src];
                return (
                  <div key={src} className="subcard">
                    <h3>{src}</h3>
                    <p>
                      Status: <code>{desc.status}</code> | Active:{' '}
                      <code>{String(desc.active)}</code>
                    </p>
                    <p className="muted">{desc.message}</p>
                    {desc.active && (
                      <button
                        type="button"
                        className="small-secondary-btn"
                        onClick={() =>
                          window.elmDesktop.requestHostStopSharingFromChatWindow(
                            src
                          )
                        }
                      >
                        Stop {src}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* EPHEMERAL BIDIRECTIONAL CHAT PANEL */}
        <section className="card card-full">
          <div className="subcard-header">
            <div>
              <h2>Bidirectional Reliable DataChannel Chat</h2>
              <p className="muted">
                Message Previews: <strong>OFF by default</strong> (messages are
                masked until you toggle reveal below, and wiped immediately on
                disconnect).
              </p>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={revealChatContentInWindow}
                onChange={(e) =>
                  setRevealChatContentInWindow(e.target.checked)
                }
              />
              <span>Reveal Message Text in Chat Window</span>
            </label>
          </div>

          {!activeSession ? (
            <p className="muted">
              No active 1:1 session. Accept an invite in the Main Window to
              connect the WebRTC DataChannel.
            </p>
          ) : (
            <>
              <div className="subcard">
                {messages.length === 0 ? (
                  <p className="muted">
                    DataChannel is{' '}
                    <code>{volatileChatState?.dataChannelState}</code>. No
                    messages sent in this session yet.
                  </p>
                ) : (
                  <ul className="feature-list">
                    {messages.map((m) => (
                      <li key={m.messageId}>
                        <strong>{m.senderDisplayName}</strong> (
                        <code>{new Date(m.sentAt).toLocaleTimeString()}</code>
                        ):{' '}
                        {revealChatContentInWindow ? (
                          <span>{m.text}</span>
                        ) : (
                          <code>
                            [Message preview hidden by default — check
                            &quot;Reveal Message Text&quot; above]
                          </code>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <form
                className="invite-form"
                onSubmit={handleSendChatFromAnyWindow}
              >
                <select
                  className="code-input"
                  style={{ maxWidth: '190px' }}
                  value={chatSenderRole}
                  onChange={(e) =>
                    setChatSenderRole(e.target.value as 'host' | 'guest')
                  }
                >
                  <option value="host">
                    Send as Host A ({activeSession.hostDisplayName})
                  </option>
                  <option value="guest">
                    Send as Guest B ({activeSession.guestDisplayName})
                  </option>
                </select>
                <input
                  type="text"
                  className="code-input"
                  placeholder="Type private message over WebRTC DataChannel..."
                  value={chatInputText}
                  onChange={(e) => setChatInputText(e.target.value)}
                />
                <button type="submit" className="primary-btn">
                  Send Over DataChannel
                </button>
              </form>
            </>
          )}
        </section>
      </main>
    );
  }

  // ============================================================================
  // MAIN APPLICATION WINDOW (windowRole === 'main')
  // ============================================================================
  const anyHostMediaActive =
    Boolean(webrtcSnap?.hostMediaState.screenVideo.active) ||
    Boolean(webrtcSnap?.hostMediaState.microphoneAudio.active) ||
    Boolean(webrtcSnap?.hostMediaState.deviceAudio.active);
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
    <main className="app-shell">
      {/* SIMPLE CUSTOM ELECTRON TITLE BAR (NO SESSION TABS) */}
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
            title="Minimize"
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
            title={isWindowMaximized ? 'Restore' : 'Maximize'}
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
            title="Close"
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
                title={pillTitle}
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

          {/* FULL-AREA ACTIVE SESSION VIEWER + ONE FLOATING PANEL */}
          {snapshot?.activeSession && webrtcSnap && (
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
                      webrtcSnap.guestVideoTracksCount === 0
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
                  {isLocalHost && stageStatus && (
                    <div
                      className="host-session-stage-card"
                      data-testid="host-session-stage"
                    >
                      <div className="host-stage-status-row">
                        <span
                          className={`presence-pill ${
                            stageStatus.state === 'sharing' ||
                            stageStatus.state === 'sharing_audio'
                              ? 'online'
                              : stageStatus.state === 'error'
                              ? 'offline'
                              : 'pending'
                          }`}
                          data-testid="host-stage-status-pill"
                        >
                          {stageStatus.headline}
                        </span>
                        <span className="muted" style={{ fontSize: '0.8rem' }}>
                          {transportStatus?.label} · {chatStatus?.label}
                        </span>
                      </div>
                      {stageStatus.detail && (
                        <p
                          className={
                            stageStatus.state === 'error'
                              ? 'host-stage-error'
                              : 'muted'
                          }
                        >
                          {stageStatus.detail}
                        </p>
                      )}
                      {stageStatus.showHostControls && (
                        <div className="host-stage-controls">
                          {webrtcSnap.hostMediaState.screenVideo.approved && (
                            <div className="host-source-picker-row">
                              <select
                                className="code-input"
                                aria-label="Select window or display to share"
                                value={selectedSourceId ?? ''}
                                onChange={(e) =>
                                  setSelectedSourceId(e.target.value || null)
                                }
                              >
                                {shareableSources.map((src) => (
                                  <option key={src.id} value={src.id}>
                                    [{src.surfaceType.toUpperCase()}] {src.name}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={handleRefreshSources}
                              >
                                Refresh Sources
                              </button>
                            </div>
                          )}
                          <div className="actions-row">
                            <button
                              type="button"
                              data-testid="host-start-sharing-button"
                              className="primary-btn"
                              disabled={isStartingShare}
                              onClick={handleExplicitStartSharing}
                            >
                              {isStartingShare
                                ? 'Starting...'
                                : webrtcSnap.hostMediaState.screenVideo.active
                                ? 'Restart Sharing'
                                : 'Start Sharing'}
                            </button>
                            {anyHostMediaActive && (
                              <button
                                type="button"
                                className="danger-btn"
                                onClick={handleStopAllSharing}
                              >
                                Stop All Sharing
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {!isLocalHost &&
                    webrtcSnap.guestVideoTracksCount === 0 &&
                    stageStatus && (
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
                      <div className="viewer-paused-overlay">
                        Local video display paused
                      </div>
                    )}
                </div>

              {/* Hidden audio elements for remote mic & device sound */}
              <audio ref={guestMicAudioRef} autoPlay />
              <audio ref={guestDeviceAudioRef} autoPlay />

              {/* ONE FLOATING PANEL ASSEMBLY OVER THE VIDEO */}
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
                      className={`presence-pill ${
                        transportStatus?.tone ?? 'pending'
                      }`}
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
                      onClick={() => setFloatingChatOpen((prev) => !prev)}
                    >
                      Chat
                    </button>

                    <button
                      type="button"
                      data-testid="floating-settings-toggle"
                      className={
                        floatingSettingsOpen
                          ? 'small-secondary-btn active'
                          : 'small-secondary-btn'
                      }
                      onClick={() => setFloatingSettingsOpen((prev) => !prev)}
                    >
                      Settings
                    </button>

                    <button
                      type="button"
                      data-testid="floating-end-session"
                      className="danger-btn"
                      onClick={handleDisconnectSession}
                    >
                      End Session
                    </button>
                  </div>

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
                      <div className="floating-chat-messages">
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
                            return (
                              <div
                                key={m.messageId}
                                className={`chat-bubble ${
                                  m.senderAccountId === account?.accountId
                                    ? 'chat-mine'
                                    : 'chat-theirs'
                                }`}
                              >
                                <div className="chat-meta">
                                  <strong>{m.senderDisplayName}</strong> ·{' '}
                                  {new Date(m.sentAt).toLocaleTimeString()}
                                </div>
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

                {/* ATTACHED RIGHT SIDEBAR (OPENS EVEN IF CHAT IS COLLAPSED) */}
                {floatingSettingsOpen && (
                  <aside
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
                            setPanelAppearance((prev) =>
                              sanitizeFloatingPanelAppearance({
                                ...prev,
                                barBgOpacity: Number(e.target.value),
                              })
                            )
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
                            setPanelAppearance((prev) =>
                              sanitizeFloatingPanelAppearance({
                                ...prev,
                                chatBgOpacity: Number(e.target.value),
                              })
                            )
                          }
                        />
                      </label>

                      <label className="sidebar-slider">
                        <span>
                          Bar Text Size: {panelAppearance.barTextSizePx}px
                        </span>
                        <input
                          type="range"
                          min={11}
                          max={16}
                          step={1}
                          value={panelAppearance.barTextSizePx}
                          onChange={(e) =>
                            setPanelAppearance((prev) =>
                              sanitizeFloatingPanelAppearance({
                                ...prev,
                                barTextSizePx: Number(e.target.value),
                              })
                            )
                          }
                        />
                      </label>

                      <label className="sidebar-slider">
                        <span>
                          Chat Text Size: {panelAppearance.chatTextSizePx}px
                        </span>
                        <input
                          type="range"
                          min={12}
                          max={18}
                          step={1}
                          value={panelAppearance.chatTextSizePx}
                          onChange={(e) =>
                            setPanelAppearance((prev) =>
                              sanitizeFloatingPanelAppearance({
                                ...prev,
                                chatTextSizePx: Number(e.target.value),
                              })
                            )
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

                    {isLocalHost && (
                      <div className="sidebar-section">
                        <strong>Host Share Controls</strong>
                        {webrtcSnap.hostMediaState.screenVideo.approved && (
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={handleRefreshSources}
                          >
                            Choose Window / Display
                          </button>
                        )}
                        {shareableSources.length > 0 && (
                          <select
                            className="code-input"
                            value={selectedSourceId ?? ''}
                            onChange={(e) =>
                              setSelectedSourceId(e.target.value || null)
                            }
                          >
                            {shareableSources.map((src) => (
                              <option key={src.id} value={src.id}>
                                [{src.surfaceType.toUpperCase()}] {src.name}
                              </option>
                            ))}
                          </select>
                        )}
                        {(webrtcSnap.hostMediaState.screenVideo.approved ||
                          webrtcSnap.hostMediaState.microphoneAudio.approved ||
                          webrtcSnap.hostMediaState.deviceAudio.approved) && (
                          <button
                            type="button"
                            className="primary-btn"
                            onClick={handleExplicitStartSharing}
                          >
                            Start Sharing
                          </button>
                        )}
                        {anyHostMediaActive && (
                          <button
                            type="button"
                            className="danger-btn"
                            onClick={handleStopAllSharing}
                          >
                            Stop All Sharing
                          </button>
                        )}
                        {(
                          [
                            'screenVideo',
                            'microphoneAudio',
                            'deviceAudio',
                          ] as const
                        ).map((src) => {
                          const st = webrtcSnap.hostMediaState[src];
                          if (!st.active) return null;
                          const label =
                            src === 'screenVideo'
                              ? 'Screen'
                              : src === 'microphoneAudio'
                                ? 'Mic'
                                : 'Device Sound';
                          return (
                            <button
                              key={src}
                              type="button"
                              className="small-secondary-btn"
                              onClick={() => handleStopIndividualSource(src)}
                            >
                              Stop {label}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <div className="sidebar-section">
                      <strong>Remote Audio</strong>
                      <div className="actions-row">
                        <button
                          type="button"
                          className="small-secondary-btn"
                          onClick={() =>
                            webrtcControllerRef.current?.updateGuestLocalPlayback(
                              {
                                micMutedLocally:
                                  !webrtcSnap.guestPlayback.micMutedLocally,
                              }
                            )
                          }
                        >
                          {webrtcSnap.guestPlayback.micMutedLocally
                            ? 'Unmute Mic'
                            : 'Mute Mic'}
                        </button>
                        <button
                          type="button"
                          className="small-secondary-btn"
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
                          {webrtcSnap.guestPlayback.deviceAudioMutedLocally
                            ? 'Unmute Sound'
                            : 'Mute Sound'}
                        </button>
                      </div>
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
