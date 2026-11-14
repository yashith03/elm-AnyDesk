import {
  STUN_ICE_SERVERS,
  STREAM_ID_BY_SOURCE,
  type ApprovedSessionSummary,
  type EphemeralChatMessage,
  type HostMediaRuntimeState,
  type HostMediaSelection,
  type MediaSourceKind,
  type MediaSourceStatusDescriptor,
  type MediaSourceStatusKind,
  type WebRtcSignalPayload,
  type WebRtcTrackDescriptor,
} from '@elm/protocol';

export interface GuestReceivedTrackInfo {
  readonly source: MediaSourceKind;
  readonly kind: 'video' | 'audio';
  readonly trackId: string;
  readonly streamId: string;
  readonly label: string;
  readonly readyState: MediaStreamTrackState;
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
}

export interface GuestLocalPlaybackControls {
  readonly videoPausedLocally: boolean;
  readonly micMutedLocally: boolean;
  readonly micVolume: number;
  readonly deviceAudioMutedLocally: boolean;
  readonly deviceAudioVolume: number;
}

export interface WebRtcSessionSnapshot {
  readonly sessionId: string;
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly dataChannelState: 'closed' | 'connecting' | 'open';
  readonly dataChannelOrdered: boolean | null;
  readonly dataChannelReliable: boolean;
  readonly sharingStartedByHost: boolean;
  readonly hostMediaState: HostMediaRuntimeState;
  readonly guestReceivedTracks: readonly GuestReceivedTrackInfo[];
  readonly guestVideoTracksCount: number;
  readonly guestAudioTracksCount: number;
  readonly totalVideoTracksEverDeliveredToGuest: number;
  readonly guestPlayback: GuestLocalPlaybackControls;
  readonly messages: readonly EphemeralChatMessage[];
  readonly lastStatusBanner: string | null;
}

interface ActiveHostSenderEntry {
  readonly source: MediaSourceKind;
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  readonly sender: RTCRtpSender;
  readonly cleanup?: () => void;
}

function createInitialHostMediaState(
  approved: HostMediaSelection
): HostMediaRuntimeState {
  const makeEntry = (
    source: MediaSourceKind,
    isApproved: boolean,
    name: string
  ): MediaSourceStatusDescriptor => ({
    source,
    approved: isApproved,
    active: false,
    status: isApproved ? 'approved_awaiting_start' : 'off',
    message: isApproved
      ? `${name} approved by Host A — awaiting explicit "Start Sharing" action.`
      : `${name} is OFF (unchecked before acceptance; will never be attached).`,
    trackId: null,
    streamId: null,
    label: null,
  });

  return {
    screenVideo: makeEntry('screenVideo', approved.screenVideo, 'Screen Video'),
    microphoneAudio: makeEntry(
      'microphoneAudio',
      approved.microphoneAudio,
      'Microphone Audio'
    ),
    deviceAudio: makeEntry('deviceAudio', approved.deviceAudio, 'Device Audio'),
  };
}

/**
 * Manages a 1:1 approved WebRTC session:
 * - Media flows strictly A -> B as separate tracks (screenVideo, microphoneAudio, deviceAudio).
 * - Private chat flows bidirectionally (A <-> B) over a reliable, ordered RTCDataChannel.
 * - Signaling (SDP offer/answer, ICE candidates, media-status) goes through the Worker/Coordinator gate.
 * - Requires Host A's explicit "Start Sharing" action before capturing or attaching any media track.
 * - Never attaches an unchecked track and never enables video to capture audio.
 */
export class ApprovedWebRtcSessionController {
  public readonly session: ApprovedSessionSummary;
  private readonly onChange: (snapshot: WebRtcSessionSnapshot) => void;

  private readonly pcHost: RTCPeerConnection;
  private readonly pcGuest: RTCPeerConnection;
  private hostDataChannel: RTCDataChannel | null = null;
  private guestDataChannel: RTCDataChannel | null = null;

  private hostAfterSeq = 0;
  private guestAfterSeq = 0;
  private negotiationQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private sharingStartedByHost = false;
  private hostMediaState: Record<MediaSourceKind, MediaSourceStatusDescriptor>;
  private readonly hostSenders = new Map<MediaSourceKind, ActiveHostSenderEntry>();
  private readonly stoppingByHost = new Set<MediaSourceKind>();

  // Track metadata sent in the latest offer from Host A -> Guest B
  private latestAdvertisedTracks: WebRtcTrackDescriptor[] = [];
  private readonly guestRawTrackEntries = new Map<
    string,
    {
      track: MediaStreamTrack;
      stream: MediaStream;
    }
  >();
  private totalVideoTracksEverDeliveredToGuest = 0;

  private guestPlayback: GuestLocalPlaybackControls = {
    videoPausedLocally: false,
    micMutedLocally: false,
    micVolume: 1.0,
    deviceAudioMutedLocally: false,
    deviceAudioVolume: 1.0,
  };

  private readonly messages: EphemeralChatMessage[] = [];
  private lastStatusBanner: string | null = null;

  // Pre-start fault injection flags for testing permission_denied / unsupported combinations
  private readonly simulatedPreStartFaults = new Map<
    MediaSourceKind,
    'permission_denied' | 'unsupported'
  >();

  constructor(
    session: ApprovedSessionSummary,
    onChange: (snapshot: WebRtcSessionSnapshot) => void
  ) {
    this.session = session;
    this.onChange = onChange;
    this.hostMediaState = {
      ...createInitialHostMediaState(session.hostMediaSelection),
    };

    const rtcConfig: RTCConfiguration = {
      iceServers: STUN_ICE_SERVERS.map((s) => ({ urls: s.urls })),
    };

    this.pcHost = new RTCPeerConnection(rtcConfig);
    this.pcGuest = new RTCPeerConnection(rtcConfig);

    this.setupPeerConnectionListeners();
  }

  private setupPeerConnectionListeners(): void {
    this.pcHost.onconnectionstatechange = () => {
      this.emitChange();
    };
    this.pcHost.oniceconnectionstatechange = () => {
      this.emitChange();
    };
    this.pcGuest.onconnectionstatechange = () => {
      this.emitChange();
    };
    this.pcGuest.oniceconnectionstatechange = () => {
      this.emitChange();
    };

    // Host A ICE candidates -> Coordinator -> Guest B
    this.pcHost.onicecandidate = (event) => {
      if (this.closed || !event.candidate) return;
      void this.sendSignalFrom(this.session.hostAccountId, {
        type: 'ice-candidate',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      });
    };

    // Guest B ICE candidates -> Coordinator -> Host A
    this.pcGuest.onicecandidate = (event) => {
      if (this.closed || !event.candidate) return;
      void this.sendSignalFrom(this.session.guestAccountId, {
        type: 'ice-candidate',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      });
    };

    // Guest B receives media tracks from Host A (A -> B only)
    this.pcGuest.ontrack = (event) => {
      if (this.closed) return;
      if (event.track.kind === 'video') {
        this.totalVideoTracksEverDeliveredToGuest += 1;
      }
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.guestRawTrackEntries.set( stream.id, {
        track: event.track,
        stream,
      });

      event.track.onmute = () => this.emitChange();
      event.track.onunmute = () => this.emitChange();
      event.track.onended = () => this.emitChange();
      this.emitChange();
    };

    // Guest B receives the reliable, ordered DataChannel created by Host A
    this.pcGuest.ondatachannel = (event) => {
      if (this.closed) return;
      const channel = event.channel;
      this.guestDataChannel = channel;
      this.attachDataChannelHandlers(channel, 'guest');
    };
  }

  private attachDataChannelHandlers(
    channel: RTCDataChannel,
    side: 'host' | 'guest'
  ): void {
    channel.onopen = () => {
      this.emitChange();
    };
    channel.onclose = () => {
      this.emitChange();
    };
    channel.onerror = () => {
      this.emitChange();
    };
    channel.onmessage = (event) => {
      if (this.closed) return;
      try {
        const parsed = JSON.parse(String(event.data)) as EphemeralChatMessage;
        if (
          parsed &&
          parsed.messageId &&
          parsed.sessionId === this.session.sessionId &&
          !this.messages.some((m) => m.messageId === parsed.messageId)
        ) {
          this.messages.push(parsed);
          this.emitChange();
        }
      } catch {
        // Ignore malformed frame
      }
      void side;
    };
  }

  /**
   * Connects the WebRTC PeerConnection and reliable DataChannel immediately upon
   * invite acceptance. Zero media tracks are captured or attached before Host A
   * explicitly clicks "Start Sharing".
   */
  public async connectAcceptedSession(): Promise<WebRtcSessionSnapshot> {
    if (this.hostDataChannel) {
      return this.getSnapshot();
    }

    // Create reliable, ordered DataChannel for bidirectional private 1:1 chat
    this.hostDataChannel = this.pcHost.createDataChannel('elm-private-chat', {
      ordered: true,
    });
    this.attachDataChannelHandlers(this.hostDataChannel, 'host');

    await this.renegotiateHostToGuest();
    await this.waitForDataChannelOpen(4000);
    this.emitChange();
    return this.getSnapshot();
  }

  private async waitForDataChannelOpen(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (
        this.closed ||
        (this.hostDataChannel?.readyState === 'open' &&
          this.guestDataChannel?.readyState === 'open')
      ) {
        return;
      }
      await this.pumpSignalsOnce();
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private buildActiveTrackDescriptors(): WebRtcTrackDescriptor[] {
    const list: WebRtcTrackDescriptor[] = [];
    for (const [source, entry] of this.hostSenders.entries()) {
      if (entry.track.readyState === 'live') {
        list.push({
          source,
          kind: entry.track.kind as 'video' | 'audio',
          trackId: entry.track.id,
          streamId: entry.stream.id,
          label: entry.track.label || STREAM_ID_BY_SOURCE[source],
        });
      }
    }
    return list;
  }

  private isPumpingSignals = false;
  private pumpAgainRequested = false;

  private async sendSignalFrom(
    senderAccountId: string,
    payload: WebRtcSignalPayload
  ): Promise<void> {
    if (this.closed) return;
    await window.elmDesktop.sendSessionSignal({
      sessionId: this.session.sessionId,
      senderAccountId,
      payload,
    });
    await this.pumpSignalsOnce();
  }

  private async pumpSignalsOnce(): Promise<void> {
    if (this.closed) return;
    if (this.isPumpingSignals) {
      this.pumpAgainRequested = true;
      return;
    }

    this.isPumpingSignals = true;
    try {
      do {
        this.pumpAgainRequested = false;

        // 1. Poll signals destined for Guest B
        const guestPoll = await window.elmDesktop.pollSessionSignals({
          sessionId: this.session.sessionId,
          receiverAccountId: this.session.guestAccountId,
          afterSeq: this.guestAfterSeq,
        });
        if (guestPoll.ok && guestPoll.data) {
          for (const env of guestPoll.data.signals) {
            if (env.seq <= this.guestAfterSeq) continue;
            this.guestAfterSeq = env.seq;
            await this.handleSignalForGuest(env.payload);
          }
        }

        // 2. Poll signals destined for Host A
        const hostPoll = await window.elmDesktop.pollSessionSignals({
          sessionId: this.session.sessionId,
          receiverAccountId: this.session.hostAccountId,
          afterSeq: this.hostAfterSeq,
        });
        if (hostPoll.ok && hostPoll.data) {
          for (const env of hostPoll.data.signals) {
            if (env.seq <= this.hostAfterSeq) continue;
            this.hostAfterSeq = env.seq;
            await this.handleSignalForHost(env.payload);
          }
        }
      } while (this.pumpAgainRequested && !this.closed);
    } finally {
      this.isPumpingSignals = false;
    }
  }

  private async handleSignalForGuest(payload: WebRtcSignalPayload): Promise<void> {
    if (this.closed) return;
    if (payload.type === 'offer') {
      this.latestAdvertisedTracks = [...payload.activeTracks];
      await this.pcGuest.setRemoteDescription({
        type: 'offer',
        sdp: payload.sdp,
      });
      const answer = await this.pcGuest.createAnswer();
      await this.pcGuest.setLocalDescription(answer);
      await window.elmDesktop.sendSessionSignal({
        sessionId: this.session.sessionId,
        senderAccountId: this.session.guestAccountId,
        payload: {
          type: 'answer',
          sdp: answer.sdp ?? '',
        },
      });
      this.pumpAgainRequested = true;
      this.emitChange();
    } else if (payload.type === 'ice-candidate') {
      try {
        await this.pcGuest.addIceCandidate({
          candidate: payload.candidate,
          sdpMid: payload.sdpMid,
          sdpMLineIndex: payload.sdpMLineIndex,
        });
      } catch {
        // Ignore late ICE candidates
      }
    } else if (payload.type === 'media-status') {
      this.latestAdvertisedTracks = [...payload.activeTracks];
      this.emitChange();
    }
  }

  private async handleSignalForHost(payload: WebRtcSignalPayload): Promise<void> {
    if (this.closed) return;
    if (payload.type === 'answer') {
      if (this.pcHost.signalingState === 'have-local-offer') {
        await this.pcHost.setRemoteDescription({
          type: 'answer',
          sdp: payload.sdp,
        });
      }
      this.emitChange();
    } else if (payload.type === 'ice-candidate') {
      try {
        await this.pcHost.addIceCandidate({
          candidate: payload.candidate,
          sdpMid: payload.sdpMid,
          sdpMLineIndex: payload.sdpMLineIndex,
        });
      } catch {
        // Ignore late ICE candidates
      }
    }
  }

  private async renegotiateHostToGuest(): Promise<void> {
    const run = async () => {
      if (this.closed) return;
      const activeTracks = this.buildActiveTrackDescriptors();
      this.latestAdvertisedTracks = activeTracks;

      const offer = await this.pcHost.createOffer();
      await this.pcHost.setLocalDescription(offer);

      await this.sendSignalFrom(this.session.hostAccountId, {
        type: 'offer',
        sdp: offer.sdp ?? '',
        activeTracks,
      });

      // Pump signals until Guest B's answer and any pending ICE candidates are processed
      for (let i = 0; i < 10; i++) {
        await this.pumpSignalsOnce();
        if (this.pcHost.signalingState === 'stable') {
          break;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
      await this.pumpSignalsOnce();
      this.emitChange();
    };

    this.negotiationQueue = this.negotiationQueue.then(run, run);
    return this.negotiationQueue;
  }

  /**
   * Configures a simulated pre-start fault ('permission_denied' or 'unsupported')
   * for a specific media source so we can deterministically verify that when a
   * permission is denied or a combination is unsupported, a specific status is shown,
   * no fallback source or video is substituted, and other approved features keep working.
   */
  public setSimulatedSourceFault(
    source: MediaSourceKind,
    fault: 'permission_denied' | 'unsupported' | null
  ): void {
    if (!fault) {
      this.simulatedPreStartFaults.delete(source);
    } else {
      this.simulatedPreStartFaults.set(source, fault);
    }
  }

  /**
   * Explicit "Start Sharing" action by Host A.
   * Only captures and attaches sources that Host A approved/checked.
   * Never attaches an unchecked track, and never enables video for audio-only capture.
   */
  public async startHostSharing(options: {
    selectedSourceId: string | null;
    playWasapiTestTone?: boolean;
    overrideSelection?: Partial<HostMediaSelection>;
  }): Promise<WebRtcSessionSnapshot> {
    if (this.closed) return this.getSnapshot();

    // Ensure initial DataChannel connection is established first
    if (!this.hostDataChannel) {
      await this.connectAcceptedSession();
    }

    this.sharingStartedByHost = true;

    const effectiveSelection: HostMediaSelection = {
      screenVideo:
        options.overrideSelection?.screenVideo ??
        this.session.hostMediaSelection.screenVideo,
      microphoneAudio:
        options.overrideSelection?.microphoneAudio ??
        this.session.hostMediaSelection.microphoneAudio,
      deviceAudio:
        options.overrideSelection?.deviceAudio ??
        this.session.hostMediaSelection.deviceAudio,
    };

    // Enforce: Any unchecked source MUST NOT be attached (and if previously active, stop it)
    const allSources: MediaSourceKind[] = [
      'screenVideo',
      'microphoneAudio',
      'deviceAudio',
    ];
    for (const source of allSources) {
      if (!effectiveSelection[source]) {
        if (this.hostSenders.has(source)) {
          await this.stopHostSource(source);
        } else {
          this.updateSourceStatus(
            source,
            false,
            false,
            'off',
            `${source} is unchecked (OFF) — never captured or attached.`
          );
        }
      }
    }

    // 1. Screen Video (only if checked by Host A)
    if (
      effectiveSelection.screenVideo &&
      !this.hostSenders.has('screenVideo')
    ) {
      await this.startScreenVideoCapture(options.selectedSourceId);
    }

    // 2. Microphone Audio (only if checked by Host A)
    if (
      effectiveSelection.microphoneAudio &&
      !this.hostSenders.has('microphoneAudio')
    ) {
      await this.startMicrophoneAudioCapture();
    }

    // 3. Device Audio (only if checked by Host A — never turns video on!)
    if (
      effectiveSelection.deviceAudio &&
      !this.hostSenders.has('deviceAudio')
    ) {
      await this.startDeviceAudioCapture(Boolean(options.playWasapiTestTone));
    }

    await this.renegotiateHostToGuest();
    this.emitChange();
    return this.getSnapshot();
  }

  private async startScreenVideoCapture(
    selectedSourceId: string | null
  ): Promise<void> {
    const fault = this.simulatedPreStartFaults.get('screenVideo');
    if (fault === 'permission_denied') {
      this.simulatedPreStartFaults.delete('screenVideo');
      this.updateSourceStatus(
        'screenVideo',
        true,
        false,
        'permission_denied',
        'Screen Video permission was denied. No fallback window/display was substituted; other approved features and chat remain active.'
      );
      this.lastStatusBanner =
        'Screen Video permission denied — continuing with remaining approved features.';
      return;
    }
    if (fault === 'unsupported') {
      this.simulatedPreStartFaults.delete('screenVideo');
      this.updateSourceStatus(
        'screenVideo',
        true,
        false,
        'unsupported',
        'Selected Screen Video capture surface is unsupported. Other approved features and chat remain active.'
      );
      this.lastStatusBanner =
        'Screen Video surface unsupported — continuing with remaining approved features.';
      return;
    }

    if (!selectedSourceId) {
      this.updateSourceStatus(
        'screenVideo',
        true,
        false,
        'permission_denied',
        'Screen Video requires an explicit window or display selection by Host A before capturing. Select a window/display and click Start Sharing.'
      );
      this.lastStatusBanner =
        'Screen Video not started: select a shareable window or display first. Other approved features remain active.';
      return;
    }

    try {
      await window.elmDesktop.selectShareableSource(selectedSourceId);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      // Ensure no audio track is ever bundled with the screen video track
      for (const strayAudio of stream.getAudioTracks()) {
        strayAudio.stop();
        stream.removeTrack(strayAudio);
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        this.updateSourceStatus(
          'screenVideo',
          true,
          false,
          'source_disappeared',
          'Selected window or display disappeared before capture could start. No fallback source was substituted.'
        );
        return;
      }

      const dedicatedStream = new MediaStream([videoTrack]);
      const sender = this.pcHost.addTrack(videoTrack, dedicatedStream);

      this.hostSenders.set('screenVideo', {
        source: 'screenVideo',
        track: videoTrack,
        stream: dedicatedStream,
        sender,
      });

      videoTrack.addEventListener('ended', () => {
        if (this.stoppingByHost.has('screenVideo')) return;
        void this.handleUnexpectedSourceDisappearance(
          'screenVideo',
          'Shared window or display was closed or disappeared. Other approved sources and private chat remain active; no fallback source was substituted.'
        );
      });

      this.updateSourceStatus(
        'screenVideo',
        true,
        true,
        'active',
        `Sharing Screen Video (${videoTrack.label || selectedSourceId}).`,
        videoTrack.id,
        dedicatedStream.id,
        videoTrack.label || 'Screen Video'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDenied =
        /Permission|NotAllowed|denied/i.test(msg) ||
        /Selected source not found/i.test(msg);
      this.updateSourceStatus(
        'screenVideo',
        true,
        false,
        isDenied ? 'permission_denied' : 'source_disappeared',
        `Screen Video could not start (${msg}). Other approved features and chat remain active.`
      );
      this.lastStatusBanner = `Screen Video status: ${msg}`;
    }
  }

  private async startMicrophoneAudioCapture(): Promise<void> {
    const fault = this.simulatedPreStartFaults.get('microphoneAudio');
    if (fault === 'permission_denied') {
      this.simulatedPreStartFaults.delete('microphoneAudio');
      this.updateSourceStatus(
        'microphoneAudio',
        true,
        false,
        'permission_denied',
        'Microphone Audio permission was denied. Other approved features and chat remain active.'
      );
      this.lastStatusBanner =
        'Microphone Audio permission denied — continuing with remaining approved features.';
      return;
    }
    if (fault === 'unsupported') {
      this.simulatedPreStartFaults.delete('microphoneAudio');
      this.updateSourceStatus(
        'microphoneAudio',
        true,
        false,
        'unsupported',
        'Microphone capture configuration is unsupported on this device. Other approved features and chat remain active.'
      );
      this.lastStatusBanner =
        'Microphone Audio unsupported — continuing with remaining approved features.';
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      // Strictly guarantee zero video tracks
      for (const strayVideo of stream.getVideoTracks()) {
        strayVideo.stop();
        stream.removeTrack(strayVideo);
      }

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        this.updateSourceStatus(
          'microphoneAudio',
          true,
          false,
          'unsupported',
          'No microphone audio track returned by OS. Other approved features remain active.'
        );
        return;
      }

      const dedicatedStream = new MediaStream([audioTrack]);
      const sender = this.pcHost.addTrack(audioTrack, dedicatedStream);

      this.hostSenders.set('microphoneAudio', {
        source: 'microphoneAudio',
        track: audioTrack,
        stream: dedicatedStream,
        sender,
      });

      audioTrack.addEventListener('ended', () => {
        if (this.stoppingByHost.has('microphoneAudio')) return;
        void this.handleUnexpectedSourceDisappearance(
          'microphoneAudio',
          'Microphone device disconnected unexpectedly. Other approved sources and private chat remain active.'
        );
      });

      this.updateSourceStatus(
        'microphoneAudio',
        true,
        true,
        'active',
        `Sharing Microphone Audio (${audioTrack.label || 'Default Microphone'}).`,
        audioTrack.id,
        dedicatedStream.id,
        audioTrack.label || 'Microphone Audio'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updateSourceStatus(
        'microphoneAudio',
        true,
        false,
        'permission_denied',
        `Microphone Audio permission denied or unavailable (${msg}). Other approved features and chat remain active.`
      );
      this.lastStatusBanner = `Microphone Audio status: ${msg}`;
    }
  }

  private async startDeviceAudioCapture(playTestTone: boolean): Promise<void> {
    const fault = this.simulatedPreStartFaults.get('deviceAudio');
    if (fault === 'permission_denied') {
      this.simulatedPreStartFaults.delete('deviceAudio');
      this.updateSourceStatus(
        'deviceAudio',
        true,
        false,
        'permission_denied',
        'Device Audio permission was denied. Video was NOT enabled; other approved features and chat remain active.'
      );
      this.lastStatusBanner =
        'Device Audio permission denied — continuing with remaining approved features.';
      return;
    }
    if (fault === 'unsupported') {
      this.simulatedPreStartFaults.delete('deviceAudio');
      this.updateSourceStatus(
        'deviceAudio',
        true,
        false,
        'unsupported',
        'Device Audio loopback is unsupported on this audio endpoint. Video was NOT enabled; other approved features and chat remain active.'
      );
      this.lastStatusBanner =
        'Device Audio unsupported — continuing with remaining approved features.';
      return;
    }

    try {
      // Verified Windows prototype capture path #1: Windows-native WASAPI Loopback helper -> WebAudio MediaStreamAudioDestinationNode
      // Never requests or enables video!
      const probe = await window.elmDesktop.startWasapiLoopback({
        playTestTone,
      });

      if (probe.ok) {
        const audioCtx = new AudioContext({
          sampleRate: probe.sampleRate || 48000,
        });
        const destination = audioCtx.createMediaStreamDestination();
        let nextPlayTime = audioCtx.currentTime;

        const unsubscribe = window.elmDesktop.onWasapiAudioChunk((chunk) => {
          if (audioCtx.state === 'closed') return;
          try {
            const binary = atob(chunk.pcmFloat32Base64);
            const byteLen = binary.length;
            const bytes = new Uint8Array(byteLen);
            for (let i = 0; i < byteLen; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            const floatSamples = new Float32Array(bytes.buffer);
            if (floatSamples.length > 0) {
              const audioBuffer = audioCtx.createBuffer(
                1,
                floatSamples.length,
                chunk.sampleRate || 48000
              );
              audioBuffer.copyToChannel(floatSamples, 0);
              const bufferSource = audioCtx.createBufferSource();
              bufferSource.buffer = audioBuffer;
              bufferSource.connect(destination);
              const startAt = Math.max(audioCtx.currentTime, nextPlayTime);
              bufferSource.start(startAt);
              nextPlayTime = startAt + audioBuffer.duration;
            }
          } catch {
            // Ignore PCM decode error
          }
        });

        const deviceTrack = destination.stream.getAudioTracks()[0];
        if (!deviceTrack) {
          unsubscribe();
          await audioCtx.close();
          await window.elmDesktop.stopWasapiLoopback();
          throw new Error('Failed to create WASAPI loopback MediaStreamTrack');
        }

        const dedicatedStream = new MediaStream([deviceTrack]);
        const sender = this.pcHost.addTrack(deviceTrack, dedicatedStream);

        const cleanup = () => {
          unsubscribe();
          void window.elmDesktop.stopWasapiLoopback();
          if (audioCtx.state !== 'closed') {
            void audioCtx.close();
          }
        };

        this.hostSenders.set('deviceAudio', {
          source: 'deviceAudio',
          track: deviceTrack,
          stream: dedicatedStream,
          sender,
          cleanup,
        });

        deviceTrack.addEventListener('ended', () => {
          if (this.stoppingByHost.has('deviceAudio')) return;
          cleanup();
          void this.handleUnexpectedSourceDisappearance(
            'deviceAudio',
            'Device Audio WASAPI loopback endpoint disappeared. Video was never enabled; other approved features and chat remain active.'
          );
        });

        this.updateSourceStatus(
          'deviceAudio',
          true,
          true,
          'active',
          `Sharing Device Audio via Windows WASAPI Loopback (${probe.sampleRate}Hz, Screen Video Never Required).`,
          deviceTrack.id,
          dedicatedStream.id,
          'Windows WASAPI Loopback Audio'
        );
        return;
      }

      // Verified Windows prototype capture path #2 fallback: Electron getDisplayMedia({ video: false, audio: true }) with loopback
      const fallbackStream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: true,
      });

      // Strictly guarantee zero video tracks
      for (const strayVideo of fallbackStream.getVideoTracks()) {
        strayVideo.stop();
        fallbackStream.removeTrack(strayVideo);
      }

      const loopbackTrack = fallbackStream.getAudioTracks()[0];
      if (!loopbackTrack) {
        throw new Error(
          probe.error || 'No device loopback audio track available'
        );
      }

      const dedicatedStream = new MediaStream([loopbackTrack]);
      const sender = this.pcHost.addTrack(loopbackTrack, dedicatedStream);

      this.hostSenders.set('deviceAudio', {
        source: 'deviceAudio',
        track: loopbackTrack,
        stream: dedicatedStream,
        sender,
      });

      loopbackTrack.addEventListener('ended', () => {
        if (this.stoppingByHost.has('deviceAudio')) return;
        void this.handleUnexpectedSourceDisappearance(
          'deviceAudio',
          'Device Audio loopback source disappeared. Other approved features and chat remain active.'
        );
      });

      this.updateSourceStatus(
        'deviceAudio',
        true,
        true,
        'active',
        `Sharing Device Audio (${loopbackTrack.label || 'System Audio Loopback'}).`,
        loopbackTrack.id,
        dedicatedStream.id,
        loopbackTrack.label || 'Device Audio Loopback'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updateSourceStatus(
        'deviceAudio',
        true,
        false,
        'unsupported',
        `Device Audio loopback unavailable (${msg}). Video was NOT enabled; other approved features and chat remain active.`
      );
      this.lastStatusBanner = `Device Audio status: ${msg}`;
    }
  }

  /**
   * Allows Host A to stop an individual active capture source ('screenVideo',
   * 'microphoneAudio', or 'deviceAudio') independently without dropping the other
   * active sources or the private DataChannel chat.
   */
  public async stopHostSource(
    source: MediaSourceKind
  ): Promise<WebRtcSessionSnapshot> {
    const entry = this.hostSenders.get(source);
    if (!entry) {
      return this.getSnapshot();
    }

    this.stoppingByHost.add(source);
    try {
      this.hostSenders.delete(source);
      try {
        this.pcHost.removeTrack(entry.sender);
      } catch {
        // Ignore if pcHost already closed
      }
      entry.track.stop();
      entry.cleanup?.();

      this.updateSourceStatus(
        source,
        this.hostMediaState[source].approved,
        false,
        'stopped_by_host',
        `${source} stopped by Host A. Other approved sources and private chat remain active.`
      );
      this.lastStatusBanner = `Host A stopped ${source} independently.`;

      await this.renegotiateHostToGuest();
    } finally {
      this.stoppingByHost.delete(source);
    }

    this.emitChange();
    return this.getSnapshot();
  }

  /**
   * Stops all active media sources on Host A while keeping the approved session
   * and bidirectional private chat connected.
   */
  public async stopAllHostSharing(): Promise<WebRtcSessionSnapshot> {
    const activeSources = Array.from(this.hostSenders.keys());
    for (const source of activeSources) {
      await this.stopHostSource(source);
    }
    this.lastStatusBanner =
      'Host A stopped all media sharing. Private 1:1 DataChannel chat remains connected.';
    this.emitChange();
    return this.getSnapshot();
  }

  /**
   * Handles unexpected disappearance of an active source (e.g., shared window closed
   * or audio device unplugged). Never substitutes another source or enables video.
   */
  public async handleUnexpectedSourceDisappearance(
    source: MediaSourceKind,
    reasonMessage?: string
  ): Promise<WebRtcSessionSnapshot> {
    const entry = this.hostSenders.get(source);
    if (entry) {
      this.stoppingByHost.add(source);
      try {
        this.hostSenders.delete(source);
        try {
          this.pcHost.removeTrack(entry.sender);
        } catch {
          // Ignore
        }
        entry.track.stop();
        entry.cleanup?.();
      } finally {
        this.stoppingByHost.delete(source);
      }
    }

    const message =
      reasonMessage ||
      `${source} disappeared unexpectedly. No fallback source was substituted; other approved features and chat remain active.`;

    this.updateSourceStatus(
      source,
      this.hostMediaState[source].approved,
      false,
      'source_disappeared',
      message
    );
    this.lastStatusBanner = message;

    await this.renegotiateHostToGuest();
    await this.sendSignalFrom(this.session.hostAccountId, {
      type: 'media-status',
      activeTracks: this.buildActiveTrackDescriptors(),
      sourceStatuses: {
        [source]: {
          status: 'source_disappeared',
          message,
        },
      },
    });

    this.emitChange();
    return this.getSnapshot();
  }

  /**
   * Sends a private chat message over the reliable WebRTC DataChannel.
   * Supports bidirectional messaging (Host A -> Guest B and Guest B -> Host A).
   * Messages are never sent to the Worker and never persisted to disk/DB.
   */
  public async sendChatMessageOverDataChannel(params: {
    sender: 'host' | 'guest';
    text: string;
  }): Promise<EphemeralChatMessage> {
    const trimmed = params.text.trim();
    if (!trimmed) {
      throw new Error('Chat message cannot be empty.');
    }

    if (
      !this.hostDataChannel ||
      this.hostDataChannel.readyState !== 'open' ||
      !this.guestDataChannel ||
      this.guestDataChannel.readyState !== 'open'
    ) {
      await this.connectAcceptedSession();
    }

    const channel =
      params.sender === 'host' ? this.hostDataChannel : this.guestDataChannel;
    if (!channel || channel.readyState !== 'open') {
      throw new Error('WebRTC reliable DataChannel is not open.');
    }

    const msg: EphemeralChatMessage = {
      messageId: crypto.randomUUID(),
      sessionId: this.session.sessionId,
      senderAccountId:
        params.sender === 'host'
          ? this.session.hostAccountId
          : this.session.guestAccountId,
      senderDisplayName:
        params.sender === 'host'
          ? this.session.hostDisplayName
          : this.session.guestDisplayName,
      text: trimmed,
      sentAt: new Date().toISOString(),
    };

    if (!this.messages.some((m) => m.messageId === msg.messageId)) {
      this.messages.push(msg);
    }

    channel.send(JSON.stringify(msg));

    // Allow microtask/SCTP loopback delivery to complete on receiving DataChannel
    await new Promise((r) => setTimeout(r, 25));
    this.emitChange();
    return msg;
  }

  /**
   * Updates Guest B's local-only playback controls.
   * Guest B can never enable, disable, or request Host A's capture sources.
   */
  public updateGuestLocalPlayback(
    patch: Partial<GuestLocalPlaybackControls>
  ): WebRtcSessionSnapshot {
    this.guestPlayback = {
      ...this.guestPlayback,
      ...patch,
    };
    this.emitChange();
    return this.getSnapshot();
  }

  private updateSourceStatus(
    source: MediaSourceKind,
    approved: boolean,
    active: boolean,
    status: MediaSourceStatusKind,
    message: string,
    trackId: string | null = null,
    streamId: string | null = null,
    label: string | null = null
  ): void {
    this.hostMediaState = {
      ...this.hostMediaState,
      [source]: {
        source,
        approved,
        active,
        status,
        message,
        trackId,
        streamId,
        label,
      },
    };
  }

  private computeGuestReceivedTracks(): GuestReceivedTrackInfo[] {
    if (this.closed) return [];

    // Active transceivers on pcGuest that are currently receiving media from pcHost
    const activeReceivingDirections = new Set(['recvonly', 'sendrecv']);
    const activeGuestTracksByStreamId = new Map<string, MediaStreamTrack>();

    for (const transceiver of this.pcGuest.getTransceivers()) {
      const dir = transceiver.currentDirection ?? transceiver.direction;
      if (!activeReceivingDirections.has(dir)) continue;
      const track = transceiver.receiver.track;
      if (track && track.readyState === 'live') {
        activeGuestTracksByStreamId.set(track.id, track);
      }
    }

    const resolved: GuestReceivedTrackInfo[] = [];
    for (const descriptor of this.latestAdvertisedTracks) {
      const rawEntry = this.guestRawTrackEntries.get(descriptor.streamId);
      if (!rawEntry) continue;
      if (rawEntry.track.readyState !== 'live') continue;
      if (!activeGuestTracksByStreamId.has(rawEntry.track.id)) continue;

      resolved.push({
        source: descriptor.source,
        kind: rawEntry.track.kind as 'video' | 'audio',
        trackId: rawEntry.track.id,
        streamId: descriptor.streamId,
        label: descriptor.label || rawEntry.track.label,
        readyState: rawEntry.track.readyState,
        track: rawEntry.track,
        stream: rawEntry.stream,
      });
    }

    return resolved;
  }

  public getSnapshot(): WebRtcSessionSnapshot {
    const guestReceivedTracks = this.computeGuestReceivedTracks();
    const guestVideoTracksCount = guestReceivedTracks.filter(
      (t) => t.kind === 'video'
    ).length;
    const guestAudioTracksCount = guestReceivedTracks.filter(
      (t) => t.kind === 'audio'
    ).length;

    const dcState =
      this.hostDataChannel?.readyState === 'open' &&
      this.guestDataChannel?.readyState === 'open'
        ? 'open'
        : this.hostDataChannel?.readyState === 'connecting' ||
          this.guestDataChannel?.readyState === 'connecting'
        ? 'connecting'
        : 'closed';

    return {
      sessionId: this.session.sessionId,
      connectionState: this.pcGuest.connectionState,
      iceConnectionState: this.pcGuest.iceConnectionState,
      dataChannelState: dcState,
      dataChannelOrdered: this.hostDataChannel?.ordered ?? null,
      dataChannelReliable:
        this.hostDataChannel !== null &&
        this.hostDataChannel.ordered === true &&
        this.hostDataChannel.maxPacketLifeTime === null &&
        this.hostDataChannel.maxRetransmits === null,
      sharingStartedByHost: this.sharingStartedByHost,
      hostMediaState: { ...this.hostMediaState },
      guestReceivedTracks,
      guestVideoTracksCount,
      guestAudioTracksCount,
      totalVideoTracksEverDeliveredToGuest:
        this.totalVideoTracksEverDeliveredToGuest,
      guestPlayback: { ...this.guestPlayback },
      messages: [...this.messages],
      lastStatusBanner: this.lastStatusBanner,
    };
  }

  private emitChange(): void {
    const snap = this.getSnapshot();
    this.onChange(snap);
  }

  /**
   * Immediately terminates all media tracks, closes the DataChannel and PeerConnections,
   * and wipes all volatile chat messages in memory. Ended sessions never resume.
   */
  public destroy(): void {
    if (this.closed) return;
    this.closed = true;

    for (const [source, entry] of this.hostSenders.entries()) {
      this.stoppingByHost.add(source);
      entry.track.stop();
      entry.cleanup?.();
    }
    this.hostSenders.clear();
    this.guestRawTrackEntries.clear();
    this.latestAdvertisedTracks = [];
    this.messages.length = 0;

    try {
      this.hostDataChannel?.close();
    } catch {
      // Ignore
    }
    try {
      this.guestDataChannel?.close();
    } catch {
      // Ignore
    }
    try {
      this.pcHost.close();
    } catch {
      // Ignore
    }
    try {
      this.pcGuest.close();
    } catch {
      // Ignore
    }
  }
}

export interface SessionCombinationVerificationReport {
  readonly mode:
    | 'chat-only'
    | 'video-only'
    | 'mic-only'
    | 'device-only'
    | 'combined';
  readonly hostSelection: HostMediaSelection;
  readonly tracksBeforeStartSharing: {
    readonly guestVideoTracks: number;
    readonly guestAudioTracks: number;
  };
  readonly dataChannel: {
    readonly state: string;
    readonly ordered: boolean | null;
    readonly reliable: boolean;
    readonly bidirectionalMessagesDelivered: number;
  };
  readonly guestReceivedAfterStartSharing: {
    readonly totalTracks: number;
    readonly videoTracksCount: number;
    readonly audioTracksCount: number;
    readonly totalVideoTracksEverDeliveredToGuest: number;
    readonly sources: readonly MediaSourceKind[];
    readonly trackDetails: ReadonlyArray<{
      readonly source: MediaSourceKind;
      readonly kind: 'video' | 'audio';
      readonly readyState: string;
      readonly label: string;
    }>;
  };
  readonly independentStopChecks?: {
    readonly afterStoppingVideo: {
      readonly videoTracksCount: number;
      readonly audioTracksCount: number;
      readonly remainingSources: readonly MediaSourceKind[];
    };
    readonly afterStoppingMic: {
      readonly videoTracksCount: number;
      readonly audioTracksCount: number;
      readonly remainingSources: readonly MediaSourceKind[];
    };
    readonly afterStoppingDeviceAudio: {
      readonly videoTracksCount: number;
      readonly audioTracksCount: number;
      readonly remainingSources: readonly MediaSourceKind[];
      readonly dataChannelStillOpen: boolean;
    };
  };
  readonly faultResilienceChecks?: {
    readonly permissionDeniedStatus: string;
    readonly sourceDisappearedStatus: string;
    readonly unsupportedStatus: string;
    readonly otherFeaturesKeptWorking: boolean;
  };
}

/**
 * Executes an end-to-end WebRTC verification of all 5 required session combinations:
 * 1. chat-only
 * 2. video-only
 * 3. mic-only
 * 4. device-only (verifying videoTracksCount === 0 and totalVideoTracksEverDeliveredToGuest === 0)
 * 5. combined (screenVideo + microphoneAudio + deviceAudio as 3 separate tracks, plus independent stop & fault resilience)
 */
export async function runAllWebRtcSessionVerificationMatrix(): Promise<
  Record<string, SessionCombinationVerificationReport>
> {
  const sources = await window.elmDesktop.listShareableSources();
  const chosenSourceId = sources[0]?.id ?? null;

  const runSingleCombination = async (
    mode: SessionCombinationVerificationReport['mode'],
    selection: HostMediaSelection
  ): Promise<SessionCombinationVerificationReport> => {
    const aliceRes = await window.elmDesktop.signInWithTestDouble('alice');
    const bobRes = await window.elmDesktop.signInWithTestDouble('bob');
    if (!aliceRes.data || !bobRes.data) {
      throw new Error('Failed to sign in test personas for WebRTC suite');
    }

    const inviteRes = await window.elmDesktop.sendFriendCodeInvite(
      aliceRes.data.account.friendCode
    );
    if (!inviteRes.ok || !inviteRes.data) {
      throw new Error(`Failed to send invite for ${mode}: ${inviteRes.errorMessage}`);
    }

    await window.elmDesktop.switchActivePersona('alice');
    const acceptRes = await window.elmDesktop.respondToInvite({
      inviteId: inviteRes.data.invite.inviteId,
      action: 'accept',
      mediaSelection: selection,
    });
    if (!acceptRes.ok || !acceptRes.data?.session) {
      throw new Error(`Failed to accept invite for ${mode}`);
    }

    const session = acceptRes.data.session;
    const controller = new ApprovedWebRtcSessionController(session, () => {});

    try {
      // 1. Connect accepted session (DataChannel connects; zero media tracks before Start Sharing)
      const beforeStartSnap = await controller.connectAcceptedSession();
      const tracksBeforeStartSharing = {
        guestVideoTracks: beforeStartSnap.guestVideoTracksCount,
        guestAudioTracks: beforeStartSnap.guestAudioTracksCount,
      };

      // 2. Verify bidirectional private chat over reliable DataChannel
      await controller.sendChatMessageOverDataChannel({
        sender: 'host',
        text: `[${mode}] Host A -> Guest B message`,
      });
      await controller.sendChatMessageOverDataChannel({
        sender: 'guest',
        text: `[${mode}] Guest B -> Host A reply`,
      });

      // 3. Explicit Start Sharing action by Host A
      const afterStartSnap =
        mode === 'chat-only'
          ? controller.getSnapshot()
          : await controller.startHostSharing({
              selectedSourceId: chosenSourceId,
              playWasapiTestTone: true,
            });

      const guestReceivedAfterStartSharing = {
        totalTracks: afterStartSnap.guestReceivedTracks.length,
        videoTracksCount: afterStartSnap.guestVideoTracksCount,
        audioTracksCount: afterStartSnap.guestAudioTracksCount,
        totalVideoTracksEverDeliveredToGuest:
          afterStartSnap.totalVideoTracksEverDeliveredToGuest,
        sources: afterStartSnap.guestReceivedTracks.map((t) => t.source),
        trackDetails: afterStartSnap.guestReceivedTracks.map((t) => ({
          source: t.source,
          kind: t.kind,
          readyState: t.readyState,
          label: t.label,
        })),
      };

      let independentStopChecks:
        | SessionCombinationVerificationReport['independentStopChecks']
        | undefined;
      let faultResilienceChecks:
        | SessionCombinationVerificationReport['faultResilienceChecks']
        | undefined;

      if (mode === 'combined') {
        // Test stopping each source independently on Host A
        const afterVideoStop = await controller.stopHostSource('screenVideo');
        const afterMicStop = await controller.stopHostSource('microphoneAudio');
        const afterDeviceStop = await controller.stopHostSource('deviceAudio');

        independentStopChecks = {
          afterStoppingVideo: {
            videoTracksCount: afterVideoStop.guestVideoTracksCount,
            audioTracksCount: afterVideoStop.guestAudioTracksCount,
            remainingSources: afterVideoStop.guestReceivedTracks.map(
              (t) => t.source
            ),
          },
          afterStoppingMic: {
            videoTracksCount: afterMicStop.guestVideoTracksCount,
            audioTracksCount: afterMicStop.guestAudioTracksCount,
            remainingSources: afterMicStop.guestReceivedTracks.map(
              (t) => t.source
            ),
          },
          afterStoppingDeviceAudio: {
            videoTracksCount: afterDeviceStop.guestVideoTracksCount,
            audioTracksCount: afterDeviceStop.guestAudioTracksCount,
            remainingSources: afterDeviceStop.guestReceivedTracks.map(
              (t) => t.source
            ),
            dataChannelStillOpen: afterDeviceStop.dataChannelState === 'open',
          },
        };

        // Test fault resilience: permission_denied, unsupported, and source_disappeared while keeping other features working
        controller.setSimulatedSourceFault('screenVideo', 'permission_denied');
        controller.setSimulatedSourceFault('deviceAudio', 'unsupported');
        const faultSnap1 = await controller.startHostSharing({
          selectedSourceId: chosenSourceId,
          playWasapiTestTone: false,
        });
        const permStatus = faultSnap1.hostMediaState.screenVideo.status;
        const unsupStatus = faultSnap1.hostMediaState.deviceAudio.status;
        const micStillWorking =
          faultSnap1.hostMediaState.microphoneAudio.status === 'active' &&
          faultSnap1.guestAudioTracksCount === 1;

        const faultSnap2 = await controller.handleUnexpectedSourceDisappearance(
          'microphoneAudio',
          'Simulated microphone unplug during active session'
        );
        const disappearedStatus =
          faultSnap2.hostMediaState.microphoneAudio.status;

        await controller.sendChatMessageOverDataChannel({
          sender: 'host',
          text: 'Chat still alive after media faults',
        });
        const finalSnap = controller.getSnapshot();

        faultResilienceChecks = {
          permissionDeniedStatus: permStatus,
          sourceDisappearedStatus: disappearedStatus,
          unsupportedStatus: unsupStatus,
          otherFeaturesKeptWorking:
            micStillWorking &&
            finalSnap.dataChannelState === 'open' &&
            finalSnap.messages.length === 3,
        };
      }

      const currentSnap = controller.getSnapshot();
      return {
        mode,
        hostSelection: selection,
        tracksBeforeStartSharing,
        dataChannel: {
          state: currentSnap.dataChannelState,
          ordered: currentSnap.dataChannelOrdered,
          reliable: currentSnap.dataChannelReliable,
          bidirectionalMessagesDelivered: currentSnap.messages.length,
        },
        guestReceivedAfterStartSharing,
        independentStopChecks,
        faultResilienceChecks,
      };
    } finally {
      controller.destroy();
      await window.elmDesktop.disconnectActiveSession(session.sessionId);
    }
  };

  const chatOnly = await runSingleCombination('chat-only', {
    screenVideo: false,
    microphoneAudio: false,
    deviceAudio: false,
  });

  const videoOnly = await runSingleCombination('video-only', {
    screenVideo: true,
    microphoneAudio: false,
    deviceAudio: false,
  });

  const micOnly = await runSingleCombination('mic-only', {
    screenVideo: false,
    microphoneAudio: true,
    deviceAudio: false,
  });

  const deviceOnly = await runSingleCombination('device-only', {
    screenVideo: false,
    microphoneAudio: false,
    deviceAudio: true,
  });

  const combined = await runSingleCombination('combined', {
    screenVideo: true,
    microphoneAudio: true,
    deviceAudio: true,
  });

  return {
    chatOnly,
    videoOnly,
    micOnly,
    deviceOnly,
    combined,
  };
}

declare global {
  interface Window {
    runElmWebRtcVerificationMatrix?: typeof runAllWebRtcSessionVerificationMatrix;
  }
}

if (typeof window !== 'undefined') {
  window.runElmWebRtcVerificationMatrix = runAllWebRtcSessionVerificationMatrix;
}

