import React, { useEffect, useState } from 'react';
import type { DesktopRuntimeMetadata } from '../shared/bridge';

export function App(): React.ReactElement {
  const [metadata, setMetadata] = useState<DesktopRuntimeMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatWindowStatus, setChatWindowStatus] = useState<string>('Closed');

  useEffect(() => {
    let mounted = true;
    window.elmDesktop
      .getRuntimeMetadata()
      .then((data) => {
        if (mounted) {
          setMetadata(data);
        }
      })
      .catch((err: unknown) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleOpenChatWindow = async () => {
    try {
      const result = await window.elmDesktop.openSeparateChatWindow();
      if (result.opened) {
        setChatWindowStatus('Opened / Focused (Separate BrowserWindow)');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) {
    return (
      <main className="app-shell">
        <section className="card card-error">
          <h1>Preload Bridge Error</h1>
          <p>{error}</p>
        </section>
      </main>
    );
  }

  if (!metadata) {
    return (
      <main className="app-shell">
        <section className="card">
          <p>Loading desktop runtime metadata via narrow preload bridge...</p>
        </section>
      </main>
    );
  }

  if (metadata.windowRole === 'chat') {
    return (
      <main className="app-shell">
        <header className="top-bar">
          <div>
            <span className="badge">Separate Chat Window</span>
            <h1>Private 1:1 Session Chat (Scaffold)</h1>
          </div>
        </header>
        <section className="card">
          <h2>Ephemeral Chat Window Architecture</h2>
          <ul className="feature-list">
            <li>Dedicated separate Electron BrowserWindow</li>
            <li>OS Notification Previews: <strong>OFF</strong></li>
            <li>Persistent Chat History: <strong>Disabled (In-Memory Only)</strong></li>
            <li>Session Resumption: <strong>Disabled (Fresh Invite Required)</strong></li>
          </ul>
          <p className="muted">
            Phase 1 scaffold only. Real-time chat signaling and session lifecycle
            enforcement will be added in Phases 3–4.
          </p>
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
        <div className="meta-pill">
          Protocol: <code>{metadata.protocolVersion}</code> | Platform:{' '}
          <code>{metadata.platform}</code>
        </div>
      </header>

      <div className="grid">
        <section className="card">
          <h2>Electron Security Posture</h2>
          <ul className="feature-list">
            <li>
              Sandbox: <code>{String(metadata.securityPosture.sandbox)}</code>
            </li>
            <li>
              Context Isolation:{' '}
              <code>{String(metadata.securityPosture.contextIsolation)}</code>
            </li>
            <li>
              Node Integration:{' '}
              <code>{String(metadata.securityPosture.nodeIntegration)}</code>
            </li>
            <li>
              Web Security:{' '}
              <code>{String(metadata.securityPosture.webSecurity)}</code>
            </li>
            <li>
              Narrow Preload Bridge:{' '}
              <code>{String(metadata.securityPosture.narrowPreloadBridge)}</code>
            </li>
          </ul>
        </section>

        <section className="card">
          <h2>Default Media Consent Invariants (Host A)</h2>
          <ul className="feature-list">
            <li>
              Screen Video (Window/Display only, never webcam):{' '}
              <code>{metadata.defaultMediaSelection.screenVideo ? 'ON' : 'OFF'}</code>
            </li>
            <li>
              Microphone Audio (Default OFF):{' '}
              <code>
                {metadata.defaultMediaSelection.microphoneAudio ? 'ON' : 'OFF'}
              </code>
            </li>
            <li>
              Device Audio (Default OFF):{' '}
              <code>{metadata.defaultMediaSelection.deviceAudio ? 'ON' : 'OFF'}</code>
            </li>
            <li>
              Initial Session State: <code>{metadata.initialSessionState}</code>
            </li>
          </ul>
        </section>

        <section className="card card-full">
          <h2>Separate Chat Window Scaffold</h2>
          <p className="muted">
            Chat runs in a separate BrowserWindow with notification previews disabled.
            Authentication, signaling, and media capture are intentionally omitted in
            Phase 1.
          </p>
          <div className="actions-row">
            <button
              type="button"
              className="primary-btn"
              onClick={handleOpenChatWindow}
            >
              Open Separate Chat Window (Scaffold)
            </button>
            <span className="status-text">Status: {chatWindowStatus}</span>
          </div>
        </section>
      </div>
    </main>
  );
}
