import React, { useEffect, useRef, useState } from 'react';
import type {
  DesktopRuntimeMetadata,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  WasapiAudioChunkPayload,
  WasapiEndpointProbeResult,
} from '../shared/bridge';

interface TrackDiagnostic {
  readonly active: boolean;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly readyState: string;
  readonly enabled: boolean;
  readonly muted: boolean;
  readonly details: string;
}

const INACTIVE_TRACK: TrackDiagnostic = {
  active: false,
  id: 'none',
  kind: 'none',
  label: 'Not started',
  readyState: 'ended',
  enabled: false,
  muted: false,
  details: 'No active MediaStreamTrack',
};

function decodeBase64Float32(b64: string): Float32Array {
  const binary = window.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

export function App(): React.ReactElement {
  const [metadata, setMetadata] = useState<DesktopRuntimeMetadata | null>(null);
  const [dwmTelemetry, setDwmTelemetry] = useState<TaskbarDwmTelemetry | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [chatWindowStatus, setChatWindowStatus] = useState<string>('Closed');

  // Independent Media Toggles (Both audio options default OFF; Screen Video defaults OFF)
  const [wantScreenVideo, setWantScreenVideo] = useState<boolean>(false);
  const [wantMicAudio, setWantMicAudio] = useState<boolean>(false);
  const [wantDeviceAudio, setWantDeviceAudio] = useState<boolean>(false);
  const [playTestTone, setPlayTestTone] = useState<boolean>(true);

  // Explicit Source Picker State
  const [sources, setSources] = useState<ShareableSourceDescriptor[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedSourceName, setSelectedSourceName] = useState<string>('None');

  // Active Track Diagnostics & Telemetry
  const [videoTrackDiag, setVideoTrackDiag] =
    useState<TrackDiagnostic>(INACTIVE_TRACK);
  const [micTrackDiag, setMicTrackDiag] =
    useState<TrackDiagnostic>(INACTIVE_TRACK);
  const [deviceAudioTrackDiag, setDeviceAudioTrackDiag] =
    useState<TrackDiagnostic>(INACTIVE_TRACK);

  const [micLevel, setMicLevel] = useState<{ rms: number; peak: number }>({
    rms: 0,
    peak: 0,
  });
  const [deviceAudioLevel, setDeviceAudioLevel] = useState<{
    rms: number;
    peak: number;
    chunksReceived: number;
  }>({ rms: 0, peak: 0, chunksReceived: 0 });

  const [wasapiProbe, setWasapiProbe] =
    useState<WasapiEndpointProbeResult | null>(null);
  const [electronDisplayAudioOnlyResult, setElectronDisplayAudioOnlyResult] =
    useState<string>('Not tested yet');
  const [sharingStatus, setSharingStatus] = useState<string>(
    'Idle — Waiting for explicit Start Sharing action'
  );

  // Media Element & Stream Refs
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const micAudioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const deviceAudioPreviewRef = useRef<HTMLAudioElement | null>(null);

  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micRafRef = useRef<number | null>(null);

  const wasapiAudioContextRef = useRef<AudioContext | null>(null);
  const wasapiDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(
    null
  );
  const wasapiNextPlayTimeRef = useRef<number>(0);
  const wasapiUnsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      window.elmDesktop.getRuntimeMetadata(),
      window.elmDesktop.getTaskbarDwmTelemetry().catch(() => null),
      window.elmDesktop.probeWasapiLoopback().catch(() => null),
    ])
      .then(([meta, dwm, probe]) => {
        if (!mounted) return;
        setMetadata(meta);
        if (dwm) setDwmTelemetry(dwm);
        if (probe) setWasapiProbe(probe);
      })
      .catch((err: unknown) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      mounted = false;
      stopScreenVideoTrack();
      stopMicrophoneTrack();
      void stopDeviceAudioTrack();
    };
  }, []);

  const refreshDwmTelemetry = async () => {
    try {
      const data = await window.elmDesktop.getTaskbarDwmTelemetry();
      setDwmTelemetry(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleMinimizeForManualHover = async () => {
    try {
      const data = await window.elmDesktop.minimizeMainWindow();
      setDwmTelemetry(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRunMinimizeRestoreCycle = async () => {
    try {
      const data = await window.elmDesktop.runTaskbarMinimizeRestoreCycle();
      setDwmTelemetry(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleVerifyStaticThumbnailAndPeek = async () => {
    try {
      const data = await window.elmDesktop.verifyStaticThumbnailAndPeek();
      setDwmTelemetry(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleLoadSources = async () => {
    try {
      const list = await window.elmDesktop.listShareableSources();
      setSources(list);
      if (list.length > 0 && !selectedSourceId) {
        const first = list[0];
        const res = await window.elmDesktop.selectShareableSource(first.id);
        setSelectedSourceId(res.selectedSourceId);
        setSelectedSourceName(`${first.name} (${first.surfaceType})`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectSource = async (source: ShareableSourceDescriptor) => {
    try {
      const res = await window.elmDesktop.selectShareableSource(source.id);
      setSelectedSourceId(res.selectedSourceId);
      setSelectedSourceName(`${source.name} (${source.surfaceType})`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTestElectronAudioOnlyDisplayMedia = async () => {
    try {
      // Explicitly test whether Electron/Chromium getDisplayMedia can capture
      // device audio with video: false (without turning video on automatically).
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: true,
      });
      stream.getTracks().forEach((t) => t.stop());
      setElectronDisplayAudioOnlyResult(
        'Unexpectedly succeeded with video: false'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setElectronDisplayAudioOnlyResult(
        `Confirmed Chromium/Electron restriction (video never auto-enabled): ${msg}`
      );
    }
  };

  const stopScreenVideoTrack = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = null;
    }
    setVideoTrackDiag(INACTIVE_TRACK);
  };

  const stopMicrophoneTrack = () => {
    if (micRafRef.current !== null) {
      cancelAnimationFrame(micRafRef.current);
      micRafRef.current = null;
    }
    if (micAudioContextRef.current) {
      void micAudioContextRef.current.close().catch(() => undefined);
      micAudioContextRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (micAudioPreviewRef.current) {
      micAudioPreviewRef.current.srcObject = null;
    }
    setMicLevel({ rms: 0, peak: 0 });
    setMicTrackDiag(INACTIVE_TRACK);
  };

  const stopDeviceAudioTrack = async () => {
    if (wasapiUnsubscribeRef.current) {
      wasapiUnsubscribeRef.current();
      wasapiUnsubscribeRef.current = null;
    }
    await window.elmDesktop.stopWasapiLoopback().catch(() => undefined);
    if (wasapiDestinationRef.current) {
      wasapiDestinationRef.current.stream.getTracks().forEach((t) => t.stop());
      wasapiDestinationRef.current = null;
    }
    if (wasapiAudioContextRef.current) {
      await wasapiAudioContextRef.current.close().catch(() => undefined);
      wasapiAudioContextRef.current = null;
    }
    if (deviceAudioPreviewRef.current) {
      deviceAudioPreviewRef.current.srcObject = null;
    }
    setDeviceAudioLevel({ rms: 0, peak: 0, chunksReceived: 0 });
    setDeviceAudioTrackDiag(INACTIVE_TRACK);
  };

  const startScreenVideoCapture = async () => {
    stopScreenVideoTrack();
    if (!selectedSourceId) {
      throw new Error(
        'Please explicitly select a Window or Display source before starting Screen Video.'
      );
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    screenStreamRef.current = stream;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      throw new Error('No video track returned from getDisplayMedia.');
    }

    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = stream;
      await videoPreviewRef.current.play().catch(() => undefined);
    }

    const settings = videoTrack.getSettings();
    setVideoTrackDiag({
      active: true,
      id: videoTrack.id,
      kind: videoTrack.kind,
      label: videoTrack.label || selectedSourceName,
      readyState: videoTrack.readyState,
      enabled: videoTrack.enabled,
      muted: videoTrack.muted,
      details: `${settings.width ?? '?'}x${settings.height ?? '?'} @ ${
        settings.frameRate ?? '?'
      }fps (Source: ${selectedSourceName})`,
    });
  };

  const startMicrophoneCapture = async () => {
    stopMicrophoneTrack();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    micStreamRef.current = stream;

    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error('No audio track returned from getUserMedia({ audio: true }).');
    }

    if (micAudioPreviewRef.current) {
      micAudioPreviewRef.current.srcObject = stream;
      await micAudioPreviewRef.current.play().catch(() => undefined);
    }

    const audioCtx = new AudioContext();
    micAudioContextRef.current = audioCtx;
    const sourceNode = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    sourceNode.connect(analyser);

    const timeData = new Float32Array(analyser.fftSize);
    const updateMeter = () => {
      analyser.getFloatTimeDomainData(timeData);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < timeData.length; i++) {
        const v = Math.abs(timeData[i]);
        sum += v * v;
        if (v > peak) peak = v;
      }
      const rms = Math.sqrt(sum / timeData.length);
      setMicLevel({ rms, peak });
      micRafRef.current = requestAnimationFrame(updateMeter);
    };
    micRafRef.current = requestAnimationFrame(updateMeter);

    const settings = audioTrack.getSettings();
    setMicTrackDiag({
      active: true,
      id: audioTrack.id,
      kind: audioTrack.kind,
      label: audioTrack.label || 'Default Microphone',
      readyState: audioTrack.readyState,
      enabled: audioTrack.enabled,
      muted: audioTrack.muted,
      details: `sampleRate=${settings.sampleRate ?? audioCtx.sampleRate}Hz, channels=${
        settings.channelCount ?? 1
      }`,
    });
  };

  const startDeviceAudioWasapiCapture = async () => {
    await stopDeviceAudioTrack();

    // Create a WebAudio pipeline that turns native WASAPI loopback PCM chunks
    // into a standard live WebRTC MediaStreamTrack (kind: 'audio') WITHOUT video!
    const audioCtx = new AudioContext({ sampleRate: 48000 });
    await audioCtx.resume();
    wasapiAudioContextRef.current = audioCtx;

    const destination = audioCtx.createMediaStreamDestination();
    wasapiDestinationRef.current = destination;
    wasapiNextPlayTimeRef.current = audioCtx.currentTime;

    let chunksCount = 0;

    const unsubscribe = window.elmDesktop.onWasapiAudioChunk(
      (chunk: WasapiAudioChunkPayload) => {
        chunksCount += 1;
        setDeviceAudioLevel({
          rms: chunk.rms,
          peak: chunk.peak,
          chunksReceived: chunksCount,
        });

        const samples = decodeBase64Float32(chunk.pcmFloat32Base64);
        if (samples.length === 0 || !wasapiAudioContextRef.current) return;

        const ctx = wasapiAudioContextRef.current;
        const audioBuffer = ctx.createBuffer(
          1,
          samples.length,
          chunk.sampleRate || 48000
        );
        audioBuffer.getChannelData(0).set(samples);

        const bufferSource = ctx.createBufferSource();
        bufferSource.buffer = audioBuffer;
        bufferSource.connect(destination);

        const now = ctx.currentTime;
        if (wasapiNextPlayTimeRef.current < now) {
          wasapiNextPlayTimeRef.current = now + 0.015;
        }
        bufferSource.start(wasapiNextPlayTimeRef.current);
        wasapiNextPlayTimeRef.current += audioBuffer.duration;
      }
    );
    wasapiUnsubscribeRef.current = unsubscribe;

    const startRes = await window.elmDesktop.startWasapiLoopback({
      playTestTone,
    });
    setWasapiProbe(startRes);

    if (!startRes.ok) {
      await stopDeviceAudioTrack();
      throw new Error(
        `WASAPI Loopback failed to start: ${startRes.error ?? 'Unknown error'}`
      );
    }

    const loopbackTrack = destination.stream.getAudioTracks()[0];
    if (!loopbackTrack) {
      throw new Error('Failed to create MediaStreamTrack from WASAPI loopback.');
    }

    if (deviceAudioPreviewRef.current) {
      deviceAudioPreviewRef.current.srcObject = destination.stream;
      await deviceAudioPreviewRef.current.play().catch(() => undefined);
    }

    setDeviceAudioTrackDiag({
      active: true,
      id: loopbackTrack.id,
      kind: loopbackTrack.kind,
      label: `WASAPI Loopback (${startRes.endpointId})`,
      readyState: loopbackTrack.readyState,
      enabled: loopbackTrack.enabled,
      muted: loopbackTrack.muted,
      details: `Native WASAPI Shared Loopback @ ${startRes.sampleRate}Hz (${startRes.channels}ch -> WebRTC MediaStreamTrack, ScreenVideo=${
        screenStreamRef.current ? 'ON' : 'OFF'
      })`,
    });
  };

  const handleExplicitStartSharing = async () => {
    setError(null);
    try {
      // Never turn video on automatically to enable audio!
      if (wantScreenVideo) {
        await startScreenVideoCapture();
      } else {
        stopScreenVideoTrack();
      }

      if (wantMicAudio) {
        await startMicrophoneCapture();
      } else {
        stopMicrophoneTrack();
      }

      if (wantDeviceAudio) {
        await startDeviceAudioWasapiCapture();
      } else {
        await stopDeviceAudioTrack();
      }

      const activeList: string[] = [];
      if (wantScreenVideo) activeList.push('Screen Video');
      if (wantMicAudio) activeList.push('Microphone Audio');
      if (wantDeviceAudio) activeList.push('Device Audio (WASAPI Loopback)');

      setSharingStatus(
        activeList.length > 0
          ? `Active Sharing: ${activeList.join(' + ')}`
          : 'All Media OFF (Chat-Only / Idle State)'
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStopAllSharing = async () => {
    stopScreenVideoTrack();
    stopMicrophoneTrack();
    await stopDeviceAudioTrack();
    setSharingStatus('Stopped all media tracks');
  };

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

  if (!metadata) {
    return (
      <main className="app-shell">
        <section className="card">
          <p>Loading Windows 11 Prototype runtime metadata...</p>
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
            <h1>Private 1:1 Session Chat (Prototype)</h1>
          </div>
        </header>
        <section className="card">
          <h2>Separate Chat Window Verification</h2>
          <ul className="feature-list">
            <li>Dedicated separate Electron BrowserWindow</li>
            <li>OS Notification Previews: <strong>OFF</strong></li>
            <li>DWM Static Thumbnail & Disallow Peek: <strong>Active</strong></li>
          </ul>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <span className="badge">{metadata.phase}</span>
          <h1>Elm-AnyDesk — Windows 11 Taskbar/DWM & Media Capture Prototype</h1>
        </div>
        <div className="meta-pill">
          Electron <code>{metadata.electronVersion}</code> | Chromium{' '}
          <code>{metadata.chromeVersion}</code> | OS{' '}
          <code>{metadata.osRelease}</code>
        </div>
      </header>

      {/* High-contrast non-sensitive test banner to verify it NEVER leaks into the taskbar hover thumbnail */}
      <section className="test-content-banner">
        <div className="banner-marker">
          NON-SENSITIVE LIVE WINDOW CONTENT MARKER: <strong>ALPHA-7392-TEST</strong>
        </div>
        <p>
          When this window is minimized and you hover its taskbar icon on Windows 11,
          this yellow/crimson banner MUST NOT appear in the thumbnail preview—only the
          static blue Elm-AnyDesk shield logo bitmap is supplied to DWM.
        </p>
      </section>

      {error && (
        <section className="card card-error">
          <h2>Prototype Error / Diagnostic Notice</h2>
          <p>{error}</p>
        </section>
      )}

      <div className="grid">
        {/* SECTION 1: Windows 11 Taskbar & DWM Static Thumbnail / Peek */}
        <section className="card card-full">
          <h2>1. Windows 11 Unpinned Taskbar, Static Logo Thumbnail & Disabled Peek</h2>
          <p className="muted">
            While open or restored, <code>setSkipTaskbar(true)</code> hides the running
            taskbar icon. On minimize, <code>setSkipTaskbar(false)</code> reveals the
            main taskbar icon for click-to-restore, while{' '}
            <code>DWMWA_FORCE_ICONIC_REPRESENTATION</code>,{' '}
            <code>DWMWA_HAS_ICONIC_BITMAP</code>, and <code>DWMWA_DISALLOW_PEEK</code>{' '}
            supply a static logo bitmap and disable full-size Aero Peek.
          </p>

          <div className="actions-row">
            <button
              type="button"
              className="primary-btn"
              onClick={handleMinimizeForManualHover}
            >
              Minimize Window (Test Taskbar Icon, Hover & Click-to-Restore)
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={handleRunMinimizeRestoreCycle}
            >
              Run Automated Open → Minimize → Thumbnail → Restore Cycle
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={handleVerifyStaticThumbnailAndPeek}
            >
              Trigger DWM Static Thumbnail Callback
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={refreshDwmTelemetry}
            >
              Refresh DWM Telemetry
            </button>
          </div>

          {dwmTelemetry && (
            <div className="telemetry-grid">
              <div className="subcard">
                <h3>Win32 Window & Taskbar State</h3>
                <ul className="feature-list">
                  <li>
                    HWND: <code>{dwmTelemetry.hwndHex}</code>
                  </li>
                  <li>
                    Minimized / Iconic:{' '}
                    <code>
                      {String(dwmTelemetry.isMinimized)} /{' '}
                      {String(dwmTelemetry.win32IsIconic)}
                    </code>
                  </li>
                  <li>
                    skipTaskbar Applied (Hidden when Open):{' '}
                    <code>{String(dwmTelemetry.skipTaskbarApplied)}</code>
                  </li>
                  <li>
                    WS_EX_APPWINDOW (True only when Minimized):{' '}
                    <code>{String(dwmTelemetry.wsExAppWindow)}</code>
                  </li>
                </ul>
              </div>

              <div className="subcard">
                <h3>DWM Attributes & Iconic Bitmap Callbacks</h3>
                <ul className="feature-list">
                  <li>
                    DWMWA_FORCE_ICONIC_REPRESENTATION (7):{' '}
                    <code>
                      {dwmTelemetry.dwmAttributes.forceIconicRepresentation}
                    </code>
                  </li>
                  <li>
                    DWMWA_HAS_ICONIC_BITMAP (10):{' '}
                    <code>{dwmTelemetry.dwmAttributes.hasIconicBitmap}</code>
                  </li>
                  <li>
                    DWMWA_DISALLOW_PEEK (11):{' '}
                    <code>{dwmTelemetry.dwmAttributes.disallowPeek}</code>
                  </li>
                  <li>
                    DWMWA_EXCLUDED_FROM_PEEK (12):{' '}
                    <code>{dwmTelemetry.dwmAttributes.excludedFromPeek}</code>
                  </li>
                  <li>
                    DwmSetIconicThumbnail Calls:{' '}
                    <code>
                      {dwmTelemetry.iconicThumbnail.callbackCount} (last:{' '}
                      {dwmTelemetry.iconicThumbnail.lastHResult},{' '}
                      {dwmTelemetry.iconicThumbnail.lastWidth}x
                      {dwmTelemetry.iconicThumbnail.lastHeight})
                    </code>
                  </li>
                </ul>
              </div>
            </div>
          )}

          {dwmTelemetry && dwmTelemetry.transitions.length > 0 && (
            <div className="log-box">
              <h3>Taskbar & DWM Transition Log (Open → Minimize → Hover/Bitmap → Restore)</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event / Action</th>
                    <th>Minimized</th>
                    <th>skipTaskbar</th>
                    <th>WS_EX_APPWINDOW</th>
                  </tr>
                </thead>
                <tbody>
                  {dwmTelemetry.transitions.slice(-8).map((t, idx) => (
                    <tr key={`${t.timestamp}-${idx}`}>
                      <td>{t.timestamp.slice(11, 23)}</td>
                      <td>
                        <code>{t.action}</code>
                      </td>
                      <td>{String(t.isMinimized)}</td>
                      <td>{String(t.skipTaskbarApplied)}</td>
                      <td>{String(t.wsExAppWindow)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* SECTION 2: Explicit Source Selection & Independent Media Capture */}
        <section className="card card-full">
          <h2>
            2. Explicit Source Selection, Microphone, Device Audio & Device Audio with
            Screen Video OFF
          </h2>
          <p className="muted">
            User A independently toggles Screen Video (window/display only, never
            webcam), Microphone Audio (default OFF), and Device Audio (default OFF).
            Media starts ONLY after clicking <strong>Start Sharing</strong>. Video is{' '}
            <strong>never</strong> turned on automatically to enable audio.
          </p>

          <div className="toggle-bar">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={wantScreenVideo}
                onChange={(e) => setWantScreenVideo(e.target.checked)}
              />
              <span>Screen Video (Window / Display Only)</span>
            </label>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={wantMicAudio}
                onChange={(e) => setWantMicAudio(e.target.checked)}
              />
              <span>Microphone Audio (Default OFF)</span>
            </label>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={wantDeviceAudio}
                onChange={(e) => setWantDeviceAudio(e.target.checked)}
              />
              <span>Device Audio — WASAPI Loopback (Default OFF, Works with Video OFF)</span>
            </label>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={playTestTone}
                onChange={(e) => setPlayTestTone(e.target.checked)}
              />
              <span>Play Non-Sensitive 440Hz System Test Tone during WASAPI Capture</span>
            </label>
          </div>

          <div className="actions-row">
            <button
              type="button"
              className="secondary-btn"
              onClick={handleLoadSources}
            >
              1. Load Shareable Windows & Displays
            </button>
            <button
              type="button"
              className="primary-btn"
              onClick={handleExplicitStartSharing}
            >
              2. Start Sharing (Explicit User A Action)
            </button>
            <button
              type="button"
              className="danger-btn"
              onClick={handleStopAllSharing}
            >
              Stop All Media
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={handleTestElectronAudioOnlyDisplayMedia}
            >
              Test Electron getDisplayMedia(video: false, audio: true)
            </button>
          </div>

          <div className="status-strip">
            <div>
              <strong>Session Media Status:</strong> <code>{sharingStatus}</code>
            </div>
            <div>
              <strong>Selected Screen Source:</strong>{' '}
              <code>{selectedSourceName}</code>
            </div>
            <div>
              <strong>Electron Display-Capture Audio-Only Check:</strong>{' '}
              <code>{electronDisplayAudioOnlyResult}</code>
            </div>
          </div>

          {sources.length > 0 && (
            <div className="sources-grid">
              {sources.map((src) => {
                const isSelected = src.id === selectedSourceId;
                return (
                  <button
                    key={src.id}
                    type="button"
                    className={`source-card ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleSelectSource(src)}
                  >
                    <img
                      src={src.thumbnailDataUrl}
                      alt={src.name}
                      className="source-thumb"
                    />
                    <div className="source-meta">
                      <span className="source-type">{src.surfaceType}</span>
                      <span className="source-name" title={src.name}>
                        {src.name}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Track Inspector & Live Playback Cards */}
          <div className="telemetry-grid">
            {/* Screen Video Track */}
            <div className="subcard">
              <div className="subcard-header">
                <h3>Screen Video Track & Playback</h3>
                {videoTrackDiag.active && (
                  <button
                    type="button"
                    className="small-danger-btn"
                    onClick={stopScreenVideoTrack}
                  >
                    Stop Video Only
                  </button>
                )}
              </div>
              <ul className="feature-list">
                <li>
                  Active: <code>{String(videoTrackDiag.active)}</code> | State:{' '}
                  <code>{videoTrackDiag.readyState}</code>
                </li>
                <li>
                  Track Label: <code>{videoTrackDiag.label}</code>
                </li>
                <li>
                  Details: <code>{videoTrackDiag.details}</code>
                </li>
              </ul>
              <video
                ref={videoPreviewRef}
                className="video-preview"
                muted
                playsInline
                controls
              />
            </div>

            {/* Microphone Audio Track */}
            <div className="subcard">
              <div className="subcard-header">
                <h3>Microphone Audio Track & Playback</h3>
                {micTrackDiag.active && (
                  <button
                    type="button"
                    className="small-danger-btn"
                    onClick={stopMicrophoneTrack}
                  >
                    Stop Mic Only
                  </button>
                )}
              </div>
              <ul className="feature-list">
                <li>
                  Active: <code>{String(micTrackDiag.active)}</code> | State:{' '}
                  <code>{micTrackDiag.readyState}</code>
                </li>
                <li>
                  Track Label: <code>{micTrackDiag.label}</code>
                </li>
                <li>
                  Details: <code>{micTrackDiag.details}</code>
                </li>
                <li>
                  Live RMS / Peak:{' '}
                  <code>
                    {micLevel.rms.toFixed(4)} / {micLevel.peak.toFixed(4)}
                  </code>
                </li>
              </ul>
              <div className="meter-track">
                <div
                  className="meter-fill"
                  style={{
                    width: `${Math.min(100, micLevel.peak * 100)}%`,
                  }}
                />
              </div>
              <audio ref={micAudioPreviewRef} controls muted className="audio-player" />
              <span className="muted-hint">
                (Unmute control above to monitor local microphone loopback)
              </span>
            </div>

            {/* Device Audio Track (WASAPI Loopback) */}
            <div className="subcard">
              <div className="subcard-header">
                <h3>Device Audio Track (WASAPI Loopback)</h3>
                {deviceAudioTrackDiag.active && (
                  <button
                    type="button"
                    className="small-danger-btn"
                    onClick={() => void stopDeviceAudioTrack()}
                  >
                    Stop Device Audio Only
                  </button>
                )}
              </div>
              <ul className="feature-list">
                <li>
                  Active: <code>{String(deviceAudioTrackDiag.active)}</code> | State:{' '}
                  <code>{deviceAudioTrackDiag.readyState}</code>
                </li>
                <li>
                  Screen Video Required?:{' '}
                  <code>
                    NO (Active Video Tracks = {videoTrackDiag.active ? 1 : 0})
                  </code>
                </li>
                <li>
                  WASAPI Endpoint:{' '}
                  <code>
                    {wasapiProbe?.ok
                      ? `${wasapiProbe.sampleRate}Hz ${wasapiProbe.channels}ch (${wasapiProbe.bitsPerSample}-bit)`
                      : wasapiProbe?.error || 'Not probed'}
                  </code>
                </li>
                <li>
                  Live RMS / Peak / Chunks:{' '}
                  <code>
                    {deviceAudioLevel.rms.toFixed(4)} /{' '}
                    {deviceAudioLevel.peak.toFixed(4)} (
                    {deviceAudioLevel.chunksReceived} chunks)
                  </code>
                </li>
              </ul>
              <div className="meter-track">
                <div
                  className="meter-fill meter-fill-cyan"
                  style={{
                    width: `${Math.min(100, deviceAudioLevel.peak * 250)}%`,
                  }}
                />
              </div>
              <audio
                ref={deviceAudioPreviewRef}
                controls
                className="audio-player"
              />
            </div>
          </div>
        </section>

        {/* SECTION 3: Separate Chat Window */}
        <section className="card card-full">
          <h2>3. Separate Chat Window (Notification Previews OFF)</h2>
          <div className="actions-row">
            <button
              type="button"
              className="secondary-btn"
              onClick={handleOpenChatWindow}
            >
              Open Separate Chat Window
            </button>
            <span className="status-text">Status: {chatWindowStatus}</span>
          </div>
        </section>
      </div>
    </main>
  );
}
