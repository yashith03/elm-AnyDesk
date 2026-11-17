import type { HostMediaRuntimeState, SessionTeardownReceipt } from '@elm/protocol';

export interface SessionStatusSnapshotInput {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly dataChannelState: 'closed' | 'connecting' | 'open';
  readonly hostMediaState: HostMediaRuntimeState;
  readonly guestVideoTracksCount: number;
  readonly teardownReceipt: SessionTeardownReceipt | null;
}

export interface TransportStatusDisplay {
  readonly label:
    | 'Connected'
    | 'Connecting'
    | 'Reconnecting'
    | 'Connection Failed'
    | 'Disconnected';
  readonly tone: 'online' | 'pending' | 'offline';
  readonly isConnected: boolean;
}

export interface ChatStatusDisplay {
  readonly label: 'Chat Connected' | 'Chat Connecting' | 'Chat Offline';
  readonly isOpen: boolean;
}

export interface RoleStageStatusDisplay {
  readonly state:
    | 'ready'
    | 'starting'
    | 'sharing'
    | 'sharing_audio'
    | 'error'
    | 'chat_only'
    | 'connecting'
    | 'waiting'
    | 'receiving'
    | 'failed';
  readonly headline: string;
  readonly detail: string | null;
  readonly showHostControls: boolean;
}

export function getTransportStatusDisplay(
  snap: Pick<
    SessionStatusSnapshotInput,
    'connectionState' | 'iceConnectionState' | 'teardownReceipt'
  >
): TransportStatusDisplay {
  if (snap.teardownReceipt || snap.connectionState === 'closed') {
    return { label: 'Disconnected', tone: 'offline', isConnected: false };
  }
  if (
    snap.connectionState === 'failed' ||
    snap.iceConnectionState === 'failed'
  ) {
    return { label: 'Connection Failed', tone: 'offline', isConnected: false };
  }
  if (
    snap.connectionState === 'connected' ||
    snap.iceConnectionState === 'connected' ||
    snap.iceConnectionState === 'completed'
  ) {
    return { label: 'Connected', tone: 'online', isConnected: true };
  }
  if (
    snap.connectionState === 'disconnected' ||
    snap.iceConnectionState === 'disconnected'
  ) {
    return { label: 'Reconnecting', tone: 'pending', isConnected: false };
  }
  return { label: 'Connecting', tone: 'pending', isConnected: false };
}

export function getChatStatusDisplay(
  snap: Pick<SessionStatusSnapshotInput, 'dataChannelState'>
): ChatStatusDisplay {
  if (snap.dataChannelState === 'open') {
    return { label: 'Chat Connected', isOpen: true };
  }
  if (snap.dataChannelState === 'connecting') {
    return { label: 'Chat Connecting', isOpen: false };
  }
  return { label: 'Chat Offline', isOpen: false };
}

export function getSessionStageStatus(params: {
  isLocalHost: boolean;
  isStartingShare: boolean;
  webrtcSnap: Pick<
    SessionStatusSnapshotInput,
    | 'connectionState'
    | 'iceConnectionState'
    | 'hostMediaState'
    | 'guestVideoTracksCount'
    | 'teardownReceipt'
  >;
}): RoleStageStatusDisplay {
  const { isLocalHost, isStartingShare, webrtcSnap } = params;
  const transport = getTransportStatusDisplay(webrtcSnap);

  if (isLocalHost) {
    const sv = webrtcSnap.hostMediaState.screenVideo;
    const mic = webrtcSnap.hostMediaState.microphoneAudio;
    const dev = webrtcSnap.hostMediaState.deviceAudio;
    const anyApproved = sv.approved || mic.approved || dev.approved;

    if (isStartingShare) {
      return {
        state: 'starting',
        headline: 'Starting',
        detail: 'Starting selected capture source...',
        showHostControls: anyApproved,
      };
    }

    const erroredSource = [sv, mic, dev].find(
      (s) =>
        s.approved &&
        !s.active &&
        (s.status === 'permission_denied' ||
          s.status === 'unsupported' ||
          s.status === 'source_disappeared')
    );

    if (sv.active) {
      return {
        state: 'sharing',
        headline: 'Sharing Your Screen',
        detail: sv.message,
        showHostControls: anyApproved,
      };
    }

    if (erroredSource) {
      return {
        state: 'error',
        headline: 'Capture Error',
        detail: erroredSource.message,
        showHostControls: anyApproved,
      };
    }

    if (mic.active || dev.active) {
      return {
        state: 'sharing_audio',
        headline: 'Sharing Audio',
        detail: mic.active ? mic.message : dev.message,
        showHostControls: anyApproved,
      };
    }

    if (anyApproved) {
      return {
        state: 'ready',
        headline: 'Ready to Share',
        detail: sv.approved
          ? 'Select a window or display and click Start Sharing.'
          : 'Audio source approved. Click Start Sharing to begin.',
        showHostControls: true,
      };
    }

    return {
      state: 'chat_only',
      headline: 'Chat-Only Session',
      detail: 'Screen and audio were left OFF when accepting this session.',
      showHostControls: false,
    };
  }

  // Guest role
  if (webrtcSnap.guestVideoTracksCount > 0) {
    return {
      state: 'receiving',
      headline: 'Receiving Video',
      detail: null,
      showHostControls: false,
    };
  }

  if (transport.label === 'Connection Failed') {
    return {
      state: 'failed',
      headline: 'Connection Failed',
      detail: 'Direct peer-to-peer connection failed.',
      showHostControls: false,
    };
  }

  if (!transport.isConnected) {
    return {
      state: 'connecting',
      headline: 'Connecting',
      detail: 'Establishing peer-to-peer connection with the host...',
      showHostControls: false,
    };
  }

  return {
    state: 'waiting',
    headline: 'Waiting for Host',
    detail: 'Connected to host. Waiting for the host to start sharing.',
    showHostControls: false,
  };
}
