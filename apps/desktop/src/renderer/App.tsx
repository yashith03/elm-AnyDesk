import React, { useEffect, useRef, useState } from 'react';
import type {
  AccountProfile,
  HostMediaSelection,
  InviteSummary,
  MediaSourceKind,
  PresenceStateSnapshot,
} from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  DeviceSetupState,
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Copy Friend Code feedback
  const [copiedCode, setCopiedCode] = useState<boolean>(false);

  // Enter Friend Code input
  const [enteredFriendCode, setEnteredFriendCode] = useState<string>('');

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
    Promise.all([
      window.elmDesktop.getRuntimeMetadata(),
      window.elmDesktop.getDeviceSetupState(),
      window.elmDesktop.getStoredAuthSession(),
      window.elmDesktop.getVolatileSessionUiState(),
      window.elmDesktop.getTaskbarDwmTelemetry().catch(() => null),
      window.elmDesktop.getThemeState().catch(() => null),
    ])
      .then(([meta, setupRes, storedRes, volatileState, dwm, initialTheme]) => {
        if (!mounted) return;
        setMetadata(meta);
        setVolatileChatState(volatileState);
        if (dwm) setDwmTelemetry(dwm);
        if (initialTheme) {
          setThemeState(initialTheme);
          applyThemeToDom(initialTheme.mode);
        }
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
        if (storedRes.ok && storedRes.data) {
          setAccount(storedRes.data.account);
          setSnapshot(storedRes.data.snapshot);
        }
      })
      .catch((err: unknown) => {
        if (mounted) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      });

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

    return () => {
      mounted = false;
      unsubVolatile();
      unsubTheme();
    };
  }, []);

  const handleToggleTheme = async () => {
    const nextMode: ThemeMode = themeState.mode === 'dark' ? 'light' : 'dark';
    applyThemeToDom(nextMode);
    const updated = await window.elmDesktop.setThemeMode(nextMode);
    setThemeState(updated);
    applyThemeToDom(updated.mode);
  };

  // Background remote presence/invite/session polling in Main Window for real registered devices
  useEffect(() => {
    if (
      !metadata ||
      metadata.windowRole !== 'main' ||
      !account ||
      account.provider === 'test-double'
    ) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const res = await window.elmDesktop.getPresenceSnapshot();
      if (!cancelled && res.ok && res.data) {
        setSnapshot(res.data.snapshot);
      }
    };

    const timer = setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [metadata?.windowRole, account?.accountId, account?.provider]);

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
      }
    );

    webrtcControllerRef.current = controller;

    // Automatically load shareable sources so Host A can pick one before clicking Start Sharing
    void window.elmDesktop.listShareableSources().then((sources) => {
      setShareableSources(sources);
      if (sources.length > 0 && !selectedSourceId) {
        setSelectedSourceId(sources[0].id);
      }
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
        const stored = await window.elmDesktop.getStoredAuthSession();
        if (stored.ok && stored.data) {
          setAccount(stored.data.account);
          setSnapshot(stored.data.snapshot);
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
          const stored = await window.elmDesktop.getStoredAuthSession();
          if (stored.ok && stored.data) {
            setAccount(stored.data.account);
            setSnapshot(stored.data.snapshot);
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
  };

  const handleTogglePresence = async (nextOnline: boolean) => {
    clearAlerts();
    const res = await window.elmDesktop.setPresenceOnline(nextOnline);
    if (res.ok && res.data) {
      setSnapshot(res.data.snapshot);
      setStatusMessage(
        nextOnline
          ? 'Presence is now ONLINE (ready to receive invites).'
          : 'Presence is now OFFLINE (incoming invites will be rejected as TARGET_OFFLINE).'
      );
    }
  };

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAlerts();
    const res = await window.elmDesktop.sendFriendCodeInvite(enteredFriendCode);
    if (!res.ok || !res.data) {
      setErrorCode(res.errorCode ?? 'INVITE_ERROR');
      setErrorMessage(res.errorMessage ?? 'Could not send invite.');
      return;
    }
    setSnapshot(res.data.snapshot);
    setStatusMessage(
      `Invite sent to ${res.data.invite.targetDisplayName} (${res.data.invite.targetFriendCode}). Waiting for owner to Accept or Decline.`
    );
    setEnteredFriendCode('');
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
    setSnapshot(res.data.snapshot);
    if (action === 'accept' && res.data.session) {
      setStatusMessage(
        `Accepted invite from ${invite.requesterDisplayName}. Reliable DataChannel chat connected. Media will not start until Host A clicks "Start Sharing".`
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
      setSnapshot(res.data.snapshot);
    }
    setStatusMessage(
      'Session ended via unified idempotent teardown path: A\'s tracks stopped, peer connections & DataChannels closed, B\'s viewer cleared, and session permissions invalidated. Send a fresh invite to connect again.'
    );
  };

  const handleRefreshSources = async () => {
    const sources = await window.elmDesktop.listShareableSources();
    setShareableSources(sources);
    if (sources.length > 0 && !selectedSourceId) {
      setSelectedSourceId(sources[0].id);
    }
  };

  const handleExplicitStartSharing = async () => {
    clearAlerts();
    const ctrl = webrtcControllerRef.current;
    if (!ctrl) return;
    await ctrl.startHostSharing({
      selectedSourceId,
      playWasapiTestTone,
    });
    setStatusMessage(
      'Host A executed explicit "Start Sharing". Only checked media sources were captured and attached as separate tracks.'
    );
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

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="brand-lockup">
            <svg
              className="brand-mark"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <rect width="24" height="24" rx="4" fill="var(--accent-action-bg)" />
              <rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="#FFFFFF" strokeWidth="1.75" />
              <rect x="8" y="8" width="8" height="8" rx="1" fill="#FFFFFF" />
            </svg>
            <h1>Elm-AnyDesk</h1>
            <span
              className={`presence-pill ${
                snapshot?.activeSession
                  ? 'online'
                  : snapshot?.online
                  ? 'online'
                  : 'offline'
              }`}
            >
              {snapshot?.activeSession
                ? 'IN SESSION'
                : snapshot?.online
                ? 'READY'
                : 'OFFLINE'}
            </span>
          </div>
        </div>
        <div className="top-bar-right">
          {snapshot?.activeSession && (
            <button
              type="button"
              data-testid="top-bar-disconnect-button"
              className="danger-btn no-drag"
              onClick={handleDisconnectSession}
            >
              Disconnect
            </button>
          )}
          {(deviceSetupState?.profileCompleted || account) && (
            <button
              type="button"
              data-testid="settings-profile-button"
              className="small-secondary-btn no-drag"
              onClick={() => setShowSettingsPanel((prev) => !prev)}
            >
              {showSettingsPanel ? 'Close Settings' : 'Settings'}
            </button>
          )}
          <ThemeToggleButton
            themeState={themeState}
            onToggle={() => void handleToggleTheme()}
          />
        </div>
      </header>

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
        <section className="card card-full" data-testid="settings-profile-card">
          <div className="subcard-header">
            <div>
              <h2>Settings — My Profile</h2>
              <p className="muted">
                Stored only on this device. Never sent to the server.
              </p>
            </div>
            <button
              type="button"
              className="small-secondary-btn"
              onClick={() => setShowSettingsPanel(false)}
            >
              Close
            </button>
          </div>
          <form className="setup-form" onSubmit={handleSaveLocalProfile}>
            <div className="setup-field">
              <label htmlFor="settings-name">Name *</label>
              <input
                id="settings-name"
                type="text"
                className="code-input"
                placeholder="Your name"
                value={setupNameInput}
                onChange={(e) => setSetupNameInput(e.target.value)}
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
                value={setupEmailInput}
                onChange={(e) => setSetupEmailInput(e.target.value)}
                maxLength={120}
              />
            </div>
            <div className="setup-field">
              <label htmlFor="settings-phone">Phone number (optional)</label>
              <input
                id="settings-phone"
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
                className="primary-btn"
                disabled={savingProfile || !setupNameInput.trim()}
              >
                {savingProfile ? 'Saving...' : 'Save Profile'}
              </button>
            </div>
          </form>
        </section>
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
                  {webrtcSnap.guestVideoTracksCount === 0 && (
                    <div
                      className="viewer-stage-empty-placeholder muted"
                      style={{ padding: '40px 20px', textAlign: 'center' }}
                    >
                      Screen sharing is currently off. The host can select a
                      window or display and click &quot;Start Sharing&quot; below.
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

                    <span className="presence-pill online">
                      {anyHostMediaActive ? 'Connected' : 'Connected'}
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
                            Decoded: {liveDiagnostics.decodedWidth ?? 0}×
                            {liveDiagnostics.decodedHeight ?? 0} @{' '}
                            {liveDiagnostics.decodedFps ?? 0}fps
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
                    onClick={() => handleRespondToInvite(activeInvite, 'accept')}
                  >
                    Accept
                  </button>
                </div>
              </section>
            );
          })()}

          {/* HOME DASHBOARD: SINGLE-ROW CONNECT + YOUR DEVICE CODE */}
          {!snapshot?.activeSession && (
            <div className="home-stack" data-testid="home-dashboard">
              <section className="card home-connect-row">
                <form className="connect-bar" onSubmit={handleSendInvite}>
                  <button
                    type="button"
                    className={`presence-pill ${
                      account
                        ? snapshot?.online
                          ? 'online'
                          : 'offline'
                        : 'offline'
                    }`}
                    disabled={!account}
                    onClick={() =>
                      void handleTogglePresence(!snapshot?.online)
                    }
                    title={
                      account
                        ? 'Toggle availability'
                        : 'Registration required before going online'
                    }
                  >
                    {account
                      ? snapshot?.online
                        ? 'Connected · Available'
                        : 'Offline'
                      : deviceSetupState.registrationStatus === 'registering'
                        ? 'Setting up...'
                        : 'Offline'}
                  </button>
                  <input
                    type="text"
                    className="code-input friend-code-input connect-bar-input"
                    placeholder="Enter a friend's device code"
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
                    className="primary-btn"
                    disabled={!account || !enteredFriendCode.trim()}
                  >
                    Send Request
                  </button>
                </form>

                {snapshot?.outgoingInvite && (
                  <div className="subcard" style={{ marginTop: '12px' }}>
                    <h3>Waiting for Approval</h3>
                    <p className="muted">
                      Request sent to{' '}
                      <code>{snapshot.outgoingInvite.targetFriendCode}</code> (
                      {snapshot.outgoingInvite.status})
                    </p>
                  </div>
                )}
              </section>

              <section className="card device-code-card">
                <div className="subcard-header">
                  <h2>Your Device Code</h2>
                </div>
                {account?.friendCode ? (
                  <div className="friend-code-display">
                    <code
                      data-testid="friend-code-value"
                      className="friend-code-value device-code-large"
                    >
                      {account.friendCode}
                    </code>
                    <button
                      type="button"
                      data-testid="copy-friend-code-button"
                      className="primary-btn"
                      onClick={handleCopyFriendCode}
                    >
                      {copiedCode ? 'Copied!' : 'Copy Code'}
                    </button>
                  </div>
                ) : (
                  <div
                    className="offline-setup-box"
                    data-testid="offline-registration-status"
                  >
                    <p className="muted">
                      {deviceSetupState.registrationMessage ||
                        'Offline before registration: unable to assign your device code yet.'}
                    </p>
                    <button
                      type="button"
                      data-testid="retry-registration-button"
                      className="primary-btn"
                      disabled={retryingRegistration}
                      onClick={() => void handleRetryRegistration()}
                    >
                      {retryingRegistration ? 'Retrying...' : 'Retry'}
                    </button>
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
    </main>
  );
}
