import React, { useEffect, useState } from 'react';
import type {
  AccountProfile,
  HostMediaSelection,
  InviteSummary,
  PresenceStateSnapshot,
} from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  TaskbarDwmTelemetry,
} from '../shared/bridge';

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
      window.elmDesktop.getTaskbarDwmTelemetry().catch(() => null),
    ])
      .then(([meta, storedRes, dwm]) => {
        if (!mounted) return;
        setMetadata(meta);
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

    return () => {
      mounted = false;
    };
  }, []);

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
    setPreAcceptMedia({
      screenVideo: false,
      microphoneAudio: false,
      deviceAudio: false,
    });
    setStatusMessage(
      `Signed in as ${res.data.account.displayName}. Permanent Friend Code (${res.data.account.friendCode}) loaded from D1 store.`
    );
  };

  const handleSignOut = async () => {
    clearAlerts();
    await window.elmDesktop.signOut();
    setAccount(null);
    setSnapshot(null);
    setStatusMessage('Signed out. Sign back in anytime to reuse your permanent Friend Code.');
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
        `Accepted invite from ${invite.requesterDisplayName} (${invite.requesterFriendCode}). 1:1 Session ${res.data.session.sessionId} is now approved.`
      );
    } else {
      setStatusMessage(
        `Declined invite from ${invite.requesterDisplayName} (${invite.requesterFriendCode}).`
      );
    }
  };

  const handleDisconnectSession = async () => {
    clearAlerts();
    const res = await window.elmDesktop.disconnectActiveSession(
      snapshot?.activeSession?.sessionId
    );
    if (!res.ok || !res.data) {
      setErrorCode(res.errorCode ?? 'DISCONNECT_ERROR');
      setErrorMessage(res.errorMessage ?? 'Failed to disconnect session.');
      return;
    }
    setSnapshot(res.data.snapshot);
    setStatusMessage(
      'Session ended for both participants. Ended sessions never resume; connecting again requires a fresh invite and fresh acceptance.'
    );
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

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <span className="badge">{metadata.phase}</span>
          <h1>Elm-AnyDesk — Consent-Based 1:1 Screen Sharing</h1>
        </div>
        <div className="top-bar-right">
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

      {/* SIGN-IN SCREEN WHEN UNATHENTICATED */}
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
                  Account ID: <code>{account.accountId}</code> | Provider:{' '}
                  <code>
                    {account.provider}:{account.providerSubject}
                  </code>
                </p>
              </div>
              <div className="actions-row">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => handleTogglePresence(!snapshot?.online)}
                >
                  {snapshot?.online ? 'Go Offline' : 'Reconnect Presence Online'}
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
                Quick Multi-Peer Switcher (simulates switching between signed-in
                accounts on one machine):
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

          {/* APPROVED ACTIVE 1:1 SESSION BANNER */}
          {snapshot?.activeSession && (
            <section className="card card-full card-session-active">
              <div className="subcard-header">
                <div>
                  <span className="badge badge-green">
                    Approved 1:1 Session Active (One Session Per User Enforced)
                  </span>
                  <h2>Session ID: {snapshot.activeSession.sessionId}</h2>
                </div>
                <button
                  type="button"
                  className="danger-btn"
                  onClick={handleDisconnectSession}
                >
                  Top-Bar Disconnect (Ends for Both)
                </button>
              </div>
              <div className="telemetry-grid">
                <div className="subcard">
                  <h3>Approved Participants</h3>
                  <ul className="feature-list">
                    <li>
                      Host (User A):{' '}
                      <strong>{snapshot.activeSession.hostDisplayName}</strong> (
                      <code>{snapshot.activeSession.hostFriendCode}</code>)
                    </li>
                    <li>
                      Guest (User B):{' '}
                      <strong>{snapshot.activeSession.guestDisplayName}</strong> (
                      <code>{snapshot.activeSession.guestFriendCode}</code>)
                    </li>
                    <li>
                      Knowing Friend Code Can Join?:{' '}
                      <code>NO (Strictly Bound to Approved Participant IDs)</code>
                    </li>
                  </ul>
                </div>
                <div className="subcard">
                  <h3>Host A Pre-Selected Media Consent</h3>
                  <ul className="feature-list">
                    <li>
                      Screen Video (Window/Display only):{' '}
                      <code>
                        {snapshot.activeSession.hostMediaSelection.screenVideo
                          ? 'ON (Awaiting Explicit Start Sharing)'
                          : 'OFF'}
                      </code>
                    </li>
                    <li>
                      Microphone Audio:{' '}
                      <code>
                        {snapshot.activeSession.hostMediaSelection
                          .microphoneAudio
                          ? 'ON'
                          : 'OFF'}
                      </code>
                    </li>
                    <li>
                      Device Audio:{' '}
                      <code>
                        {snapshot.activeSession.hostMediaSelection.deviceAudio
                          ? 'ON'
                          : 'OFF'}
                      </code>
                    </li>
                  </ul>
                  <p className="muted-hint">
                    Note: Media and chat transport are deferred to the next
                    phases per phase scope.
                  </p>
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
            {/* MY FRIEND CODE & COPY CODE */}
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

            {/* ENTER FRIEND CODE & SEND INVITE */}
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
                      Target: <strong>{snapshot.outgoingInvite.targetDisplayName}</strong>{' '}
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
