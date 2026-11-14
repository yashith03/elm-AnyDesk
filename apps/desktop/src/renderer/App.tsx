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
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  VolatileSessionUiState,
} from '../shared/bridge';
import {
  ApprovedWebRtcSessionController,
  runAllWebRtcSessionVerificationMatrix,
  runPhase4LifecycleAndTeardownVerificationSuite,
  type Phase4VerificationSuiteReport,
  type SessionCombinationVerificationReport,
  type WebRtcSessionSnapshot,
} from './webrtc-session';

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
  const [playWasapiTestTone, setPlayWasapiTestTone] = useState<boolean>(true);

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
  };

  // Prototype drawer state
  const [showPrototypeDrawer, setShowPrototypeDrawer] =
    useState<boolean>(false);
  const [dwmTelemetry, setDwmTelemetry] = useState<TaskbarDwmTelemetry | null>(
    null
  );

  useEffect(() => {
    let mounted = true;
    Promise.all([
      window.elmDesktop.getRuntimeMetadata(),
      window.elmDesktop.getStoredAuthSession(),
      window.elmDesktop.getVolatileSessionUiState(),
      window.elmDesktop.getTaskbarDwmTelemetry().catch(() => null),
    ])
      .then(([meta, storedRes, volatileState, dwm]) => {
        if (!mounted) return;
        setMetadata(meta);
        setVolatileChatState(volatileState);
        if (dwm) setDwmTelemetry(dwm);
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

    return () => {
      mounted = false;
      unsubVolatile();
    };
  }, []);

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

  const clearAlerts = () => {
    setErrorMessage(null);
    setErrorCode(null);
    setStatusMessage(null);
  };

  const handleBrowserOAuthSignIn = async () => {
    clearAlerts();
    const res = await window.elmDesktop.startBrowserOAuthSignIn();
    if (!res.ok) {
      setErrorCode(res.errorCode ?? 'AUTH_PROVIDER_NOT_CONFIGURED');
      setErrorMessage(
        res.errorMessage ?? 'Browser OAuth sign-in is not configured.'
      );
      return;
    }
    setStatusMessage(res.data?.message ?? 'Opened browser for OAuth sign-in.');
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
    const text = chatInputText.trim();
    if (!text) return;
    setChatInputText('');

    if (metadata?.windowRole === 'chat') {
      await window.elmDesktop.sendChatFromChatWindow({
        text,
        senderOverride: chatSenderRole,
      });
      return;
    }

    const ctrl = webrtcControllerRef.current;
    if (!ctrl) return;
    await ctrl.sendChatMessageOverDataChannel({
      sender: chatSenderRole,
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
          <div>
            <span className="badge">
              Separate 1:1 Chat Window — Volatile DataChannel Only
            </span>
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
                className="danger-btn"
                onClick={handleDisconnectSession}
              >
                Top-Bar Disconnect
              </button>
            )}
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

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <span className="badge">{metadata.phase}</span>
          <h1>Elm-AnyDesk — Consent-Based 1:1 Screen Sharing</h1>
        </div>
        <div className="top-bar-right">
          <button
            type="button"
            className="secondary-btn"
            onClick={() => window.elmDesktop.openSeparateChatWindow()}
          >
            Open Separate Chat Window (
            {webrtcSnap ? `${webrtcSnap.messages.length} msgs` : '0 msgs'} — No
            Preview)
          </button>
          {snapshot?.activeSession && (
            <button
              type="button"
              className="danger-btn"
              onClick={handleDisconnectSession}
            >
              Disconnect Active Session
            </button>
          )}
          <div className="meta-pill">
            Protocol <code>{metadata.protocolVersion}</code> | Electron{' '}
            <code>{metadata.electronVersion}</code>
          </div>
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
          <strong>Live Media Status Notice: </strong>
          <span>{webrtcSnap.lastStatusBanner}</span>
        </section>
      )}

      {/* SIGN-IN SCREEN WHEN UNAUTHENTICATED */}
      {!account ? (
        <div className="grid">
          <section className="card">
            <h2>1. Production Desktop-Safe Browser Sign-In</h2>
            <p className="muted">
              Uses GitHub OAuth 2.0 in your system browser with a local loopback
              callback listener (<code>127.0.0.1</code>). Provider secrets live
              strictly on the Cloudflare Worker (<code>apps/api/.dev.vars</code>)
              and are never bundled into Electron.
            </p>
            <div className="actions-row">
              <button
                type="button"
                className="primary-btn"
                onClick={handleBrowserOAuthSignIn}
              >
                Sign In with GitHub (System Browser)
              </button>
            </div>
          </section>

          <section className="card">
            <h2>2. Local Test-Double Adapter (No Secrets Required)</h2>
            <p className="muted">
              Isolated behind <code>AuthProviderAdapter</code> for local
              development & multi-peer testing when OAuth secrets are unavailable
              locally. Creates a permanent Friend Code once in D1 storage and
              reuses it across restarts and sign-ins.
            </p>
            <div className="actions-row">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => handleTestDoubleSignIn('alice')}
              >
                Sign In as Alice (Host A)
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => handleTestDoubleSignIn('bob')}
              >
                Sign In as Bob (Requester B)
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => handleTestDoubleSignIn('charlie')}
              >
                Sign In as Charlie (Peer C)
              </button>
            </div>
          </section>
        </div>
      ) : (
        <>
          {/* ACCOUNT & PRESENCE BAR */}
          <section className="card card-full">
            <div className="subcard-header">
              <div>
                <h2>
                  Signed In: {account.displayName}{' '}
                  <span
                    className={`presence-pill ${
                      snapshot?.online ? 'online' : 'offline'
                    }`}
                  >
                    {snapshot?.online ? 'ONLINE' : 'OFFLINE'}
                  </span>
                </h2>
                <p className="muted">
                  Account ID: <code>{account.accountId}</code> | Permanent Friend
                  Code: <code>{account.friendCode}</code>
                </p>
              </div>
              <div className="actions-row">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => handleTogglePresence(!snapshot?.online)}
                >
                  {snapshot?.online
                    ? 'Go Offline'
                    : 'Reconnect Presence Online'}
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleSignOut}
                >
                  Sign Out
                </button>
              </div>
            </div>

            <div className="persona-switcher-bar">
              <span className="muted">
                Quick Multi-Peer Switcher (switch between Alice, Bob, and
                Charlie):
              </span>
              <div className="actions-row">
                <button
                  type="button"
                  className="small-secondary-btn"
                  onClick={() => handleTestDoubleSignIn('alice')}
                >
                  Switch to Alice (Host A)
                </button>
                <button
                  type="button"
                  className="small-secondary-btn"
                  onClick={() => handleTestDoubleSignIn('bob')}
                >
                  Switch to Bob (Requester B)
                </button>
                <button
                  type="button"
                  className="small-secondary-btn"
                  onClick={() => handleTestDoubleSignIn('charlie')}
                >
                  Switch to Charlie (Peer C)
                </button>
              </div>
            </div>
          </section>

          {/* APPROVED ACTIVE 1:1 WEBRTC SESSION PANEL */}
          {snapshot?.activeSession && webrtcSnap && (
            <section className="card card-full card-session-active">
              <div className="subcard-header">
                <div>
                  <span className="badge badge-green">
                    Approved 1:1 WebRTC Session — Media A → B | Chat A ↔ B (
                    {anyHostMediaActive
                      ? 'SHARING ACTIVE'
                      : 'CHAT CONNECTED / MEDIA IDLE'}
                    )
                  </span>
                  <h2>Session ID: {snapshot.activeSession.sessionId}</h2>
                  <p className="muted">
                    PeerConnection: <code>{webrtcSnap.connectionState}</code> |
                    Reliable DataChannel:{' '}
                    <code>
                      {webrtcSnap.dataChannelState} (ordered=
                      {String(webrtcSnap.dataChannelOrdered)}, reliable=
                      {String(webrtcSnap.dataChannelReliable)})
                    </code>
                  </p>
                </div>
                <div className="actions-row">
                  <button
                    type="button"
                    className="danger-btn"
                    disabled={!anyHostMediaActive}
                    onClick={handleStopAllSharing}
                  >
                    Stop All Sharing (Host A)
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => window.elmDesktop.openSeparateChatWindow()}
                  >
                    Open Separate Chat Window
                  </button>
                  <button
                    type="button"
                    className="danger-btn"
                    onClick={handleDisconnectSession}
                  >
                    Top-Bar Disconnect (Ends for Both)
                  </button>
                </div>
              </div>

              <div className="telemetry-grid">
                {/* HOST A: EXPLICIT START SHARING & INDEPENDENT SOURCE CONTROLS */}
                <div className="subcard">
                  <h3>
                    Host A ({snapshot.activeSession.hostDisplayName}) — Capture
                    Controls
                  </h3>
                  <p className="muted">
                    Media never starts before Host A clicks{' '}
                    <strong>Start Sharing</strong>. Unchecked sources are never
                    captured or attached. Each active source can be stopped
                    independently.
                  </p>

                  <div className="actions-row">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={handleRefreshSources}
                    >
                      1. Load Shareable Windows & Displays
                    </button>
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={handleExplicitStartSharing}
                    >
                      2. Explicit Start Sharing (Host A)
                    </button>
                  </div>

                  {shareableSources.length > 0 && (
                    <div className="actions-row">
                      <label className="muted">
                        Selected Window/Display (Never Webcam):{' '}
                      </label>
                      <select
                        className="code-input"
                        value={selectedSourceId ?? ''}
                        onChange={(e) =>
                          setSelectedSourceId(e.target.value || null)
                        }
                      >
                        {shareableSources.map((src) => (
                          <option key={src.id} value={src.id}>
                            [{src.surfaceType.toUpperCase()}] {src.name} (
                            {src.id})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={playWasapiTestTone}
                      onChange={(e) => setPlayWasapiTestTone(e.target.checked)}
                    />
                    <span>
                      Play 440Hz Reference Tone in WASAPI Loopback Helper
                    </span>
                  </label>

                  <ul className="feature-list">
                    {(
                      [
                        'screenVideo',
                        'microphoneAudio',
                        'deviceAudio',
                      ] as const
                    ).map((src) => {
                      const st = webrtcSnap.hostMediaState[src];
                      return (
                        <li key={src}>
                          <div>
                            <strong>{src}</strong> — Approved:{' '}
                            <code>{String(st.approved)}</code> | Active:{' '}
                            <code>{String(st.active)}</code> | Status:{' '}
                            <code>{st.status}</code>
                          </div>
                          <div className="muted">{st.message}</div>
                          <div className="actions-row">
                            {st.active && (
                              <button
                                type="button"
                                className="small-secondary-btn"
                                onClick={() =>
                                  handleStopIndividualSource(src)
                                }
                              >
                                Stop {src} Only
                              </button>
                            )}
                            <button
                              type="button"
                              className="small-secondary-btn"
                              onClick={() => {
                                webrtcControllerRef.current?.setSimulatedSourceFault(
                                  src,
                                  'permission_denied'
                                );
                                setStatusMessage(
                                  `Armed permission_denied fault for ${src} on next Start Sharing.`
                                );
                              }}
                            >
                              Simulate Permission Denied
                            </button>
                            <button
                              type="button"
                              className="small-secondary-btn"
                              onClick={() => {
                                void webrtcControllerRef.current?.handleUnexpectedSourceDisappearance(
                                  src,
                                  `${src} disappeared mid-session (simulated source closure). Other approved features remain active.`
                                );
                              }}
                            >
                              Simulate Source Disappeared
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {/* GUEST B: RECEIVED TRACKS & LOCAL-ONLY PLAYBACK CONTROLS */}
                <div className="subcard">
                  <h3>
                    Guest B ({snapshot.activeSession.guestDisplayName}) —
                    Received Tracks & Local Playback
                  </h3>
                  <p className="muted">
                    Guest B can control <strong>only local playback</strong> and
                    cannot enable or request Host A&apos;s capture sources.
                  </p>

                  <ul className="feature-list">
                    <li>
                      Active Received Tracks on B:{' '}
                      <code>{webrtcSnap.guestReceivedTracks.length}</code> (
                      Video: <code>{webrtcSnap.guestVideoTracksCount}</code>,
                      Audio: <code>{webrtcSnap.guestAudioTracksCount}</code>)
                    </li>
                    <li>
                      Total Video Tracks Ever Delivered to B in Session:{' '}
                      <code>
                        {webrtcSnap.totalVideoTracksEverDeliveredToGuest}
                      </code>{' '}
                      (Device-only & Mic-only always <code>0</code>)
                    </li>
                    {webrtcSnap.guestReceivedTracks.map((t) => (
                      <li key={t.streamId}>
                        Track <code>{t.source}</code> ({t.kind}):{' '}
                        <code>{t.readyState}</code> — Label:{' '}
                        <code>{t.label}</code> | Stream:{' '}
                        <code>{t.streamId}</code>
                      </li>
                    ))}
                  </ul>

                  {/* Guest B Local-Only Playback Controls */}
                  <div className="actions-row">
                    <button
                      type="button"
                      className="small-secondary-btn"
                      onClick={() =>
                        webrtcControllerRef.current?.updateGuestLocalPlayback({
                          videoPausedLocally:
                            !webrtcSnap.guestPlayback.videoPausedLocally,
                        })
                      }
                    >
                      {webrtcSnap.guestPlayback.videoPausedLocally
                        ? 'Resume Local Video Display (B)'
                        : 'Pause Local Video Display (B)'}
                    </button>
                    <button
                      type="button"
                      className="small-secondary-btn"
                      onClick={() =>
                        webrtcControllerRef.current?.updateGuestLocalPlayback({
                          micMutedLocally:
                            !webrtcSnap.guestPlayback.micMutedLocally,
                        })
                      }
                    >
                      {webrtcSnap.guestPlayback.micMutedLocally
                        ? 'Unmute Mic Playback (B)'
                        : 'Mute Mic Playback (B)'}
                    </button>
                    <button
                      type="button"
                      className="small-secondary-btn"
                      onClick={() =>
                        webrtcControllerRef.current?.updateGuestLocalPlayback({
                          deviceAudioMutedLocally:
                            !webrtcSnap.guestPlayback.deviceAudioMutedLocally,
                        })
                      }
                    >
                      {webrtcSnap.guestPlayback.deviceAudioMutedLocally
                        ? 'Unmute Device Audio Playback (B)'
                        : 'Mute Device Audio Playback (B)'}
                    </button>
                  </div>

                  <video
                    ref={guestVideoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{
                      width: '100%',
                      maxHeight: '180px',
                      background: '#020617',
                      borderRadius: '6px',
                      marginTop: '8px',
                    }}
                  />
                  <audio ref={guestMicAudioRef} autoPlay />
                  <audio ref={guestDeviceAudioRef} autoPlay />
                </div>
              </div>
            </section>
          )}

          {/* INCOMING INVITES ACCEPT / DECLINE SCREEN (USER A) */}
          {snapshot && snapshot.incomingInvites.length > 0 && (
            <section className="card card-full card-incoming-invite">
              <span className="badge">Incoming Session Invite</span>
              <h2>Incoming Invite — Choose Media Consent Before Accepting</h2>
              <p className="muted">
                Choose Screen Video, Microphone Audio, and Device Audio
                independently before accepting. Both audio options default{' '}
                <strong>OFF</strong>. The requester cannot enable your capture.
                Screen Video means a window or display selected by you, never a
                webcam.
              </p>

              <div className="toggle-bar">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={preAcceptMedia.screenVideo}
                    onChange={(e) =>
                      setPreAcceptMedia((prev) => ({
                        ...prev,
                        screenVideo: e.target.checked,
                      }))
                    }
                  />
                  <span>
                    Screen Video (Window / Display Only — Never Webcam)
                  </span>
                </label>

                <label className="checkbox-label">
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
                  <span>Microphone Audio (Default OFF)</span>
                </label>

                <label className="checkbox-label">
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
                  <span>Device / System Audio (Default OFF)</span>
                </label>
              </div>

              <div className="telemetry-grid">
                {snapshot.incomingInvites.map((inv) => (
                  <div key={inv.inviteId} className="subcard">
                    <h3>Requester Identity</h3>
                    <ul className="feature-list">
                      <li>
                        Display Name: <strong>{inv.requesterDisplayName}</strong>
                      </li>
                      <li>
                        Friend Code: <code>{inv.requesterFriendCode}</code>
                      </li>
                      <li>
                        Account ID: <code>{inv.requesterAccountId}</code>
                      </li>
                      <li>
                        Invite ID: <code>{inv.inviteId}</code>
                      </li>
                    </ul>
                    <div className="actions-row">
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={() => handleRespondToInvite(inv, 'accept')}
                      >
                        Accept Invite
                      </button>
                      <button
                        type="button"
                        className="danger-btn"
                        onClick={() => handleRespondToInvite(inv, 'decline')}
                      >
                        Decline Invite
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* MAIN TWO-COLUMN: MY FRIEND CODE & ENTER FRIEND CODE */}
          <div className="grid">
            <section className="card">
              <h2>My Friend Code</h2>
              <p className="muted">
                Your permanent, reusable Friend Code. It is created once in D1,
                never expires, reuses the same value across restarts and
                sign-ins, and never grants automatic access on its own.
              </p>
              <div className="friend-code-display">
                <code className="friend-code-value">{account.friendCode}</code>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={handleCopyFriendCode}
                >
                  {copiedCode ? 'Copied!' : 'Copy Code'}
                </button>
              </div>
            </section>

            <section className="card">
              <h2>Enter Friend Code & Send Invite</h2>
              <p className="muted">
                Enter your peer&apos;s Friend Code (<code>ELM-XXXX-XXXX</code>)
                to send a 1:1 session invite. They must be online and explicitly
                Accept.
              </p>
              <form className="invite-form" onSubmit={handleSendInvite}>
                <input
                  type="text"
                  className="code-input"
                  placeholder="ELM-XXXX-XXXX"
                  value={enteredFriendCode}
                  onChange={(e) =>
                    setEnteredFriendCode(e.target.value.toUpperCase())
                  }
                  maxLength={13}
                />
                <button type="submit" className="primary-btn">
                  Send Invite
                </button>
              </form>

              {snapshot?.outgoingInvite && (
                <div className="subcard">
                  <h3>Outgoing Invite Pending</h3>
                  <ul className="feature-list">
                    <li>
                      Target:{' '}
                      <strong>
                        {snapshot.outgoingInvite.targetDisplayName}
                      </strong>{' '}
                      (<code>{snapshot.outgoingInvite.targetFriendCode}</code>)
                    </li>
                    <li>
                      Status: <code>{snapshot.outgoingInvite.status}</code> (No
                      signaling admitted before acceptance)
                    </li>
                  </ul>
                </div>
              )}
            </section>
          </div>
        </>
      )}

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
    </main>
  );
}
