import type { HostMediaRuntimeState } from '@elm/protocol';

export type HostMicUiState =
  | 'approved'
  | 'starting'
  | 'active'
  | 'muted'
  | 'unavailable'
  | 'denied';
export type HostSoundUiState =
  | 'approved'
  | 'starting'
  | 'active'
  | 'unavailable'
  | 'denied';
export type HostScreenUiState =
  | 'approved'
  | 'starting'
  | 'sharing'
  | 'unavailable'
  | 'denied';
export type PeerAudioUiState = 'active' | 'muted' | 'unavailable';
export type PeerScreenUiState = 'received' | 'hidden' | 'unavailable';

export interface ToolbarControlState<TState extends string> {
  readonly state: TState;
  readonly label: string;
  readonly title: string;
  readonly disabled: boolean;
  readonly pressed: boolean;
}

export interface HostToolbarMediaControls {
  readonly myMic: ToolbarControlState<HostMicUiState>;
  readonly deviceSound: ToolbarControlState<HostSoundUiState>;
  readonly myScreen: ToolbarControlState<HostScreenUiState>;
  readonly sourcePicker: {
    readonly disabled: boolean;
    readonly title: string;
  };
}

export interface ViewerToolbarMediaControls {
  readonly myMic: ToolbarControlState<'unavailable'>;
  readonly peerMic: ToolbarControlState<PeerAudioUiState>;
  readonly peerSound: ToolbarControlState<PeerAudioUiState>;
  readonly peerScreen: ToolbarControlState<PeerScreenUiState>;
}

export interface GuestPlaybackStateInput {
  readonly videoPausedLocally: boolean;
  readonly micMutedLocally: boolean;
  readonly deviceAudioMutedLocally: boolean;
}

export function computeHostToolbarMediaControls(params: {
  hostMediaState: HostMediaRuntimeState;
  hostMicMutedLocally: boolean;
  isStartingShare: boolean;
  isStartingMic?: boolean;
  isStartingDeviceSound?: boolean;
}): HostToolbarMediaControls {
  const {
    hostMediaState,
    hostMicMutedLocally,
    isStartingShare,
    isStartingMic,
    isStartingDeviceSound,
  } = params;
  const mic = hostMediaState.microphoneAudio;
  const sound = hostMediaState.deviceAudio;
  const screen = hostMediaState.screenVideo;

  let myMic: ToolbarControlState<HostMicUiState>;
  if (!mic.approved) {
    myMic = {
      state: 'unavailable',
      label: 'My Mic',
      title:
        'Microphone was not approved when accepting this session. Unapproved microphone capture remains disabled.',
      disabled: true,
      pressed: false,
    };
  } else if (mic.status === 'permission_denied') {
    myMic = {
      state: 'denied',
      label: 'My Mic',
      title:
        mic.message ||
        'Microphone permission was denied by the OS. Grant microphone access and start a new session.',
      disabled: true,
      pressed: false,
    };
  } else if (
    mic.status === 'unsupported' ||
    mic.status === 'source_disappeared'
  ) {
    myMic = {
      state: 'unavailable',
      label: 'My Mic',
      title: mic.message || 'Microphone is unavailable on this device.',
      disabled: true,
      pressed: false,
    };
  } else if (isStartingMic || mic.status === 'starting') {
    myMic = {
      state: 'starting',
      label: 'My Mic',
      title: 'Starting microphone capture...',
      disabled: true,
      pressed: false,
    };
  } else if (mic.active) {
    if (hostMicMutedLocally) {
      myMic = {
        state: 'muted',
        label: 'My Mic',
        title: 'Your microphone is muted locally. Click to unmute.',
        disabled: false,
        pressed: false,
      };
    } else {
      myMic = {
        state: 'active',
        label: 'My Mic',
        title: 'Your microphone is live. Click to mute locally.',
        disabled: false,
        pressed: true,
      };
    }
  } else {
    myMic = {
      state: 'approved',
      label: 'My Mic',
      title:
        'Microphone is approved and ready. Click to start sharing your microphone.',
      disabled: false,
      pressed: false,
    };
  }

  let deviceSound: ToolbarControlState<HostSoundUiState>;
  if (!sound.approved) {
    deviceSound = {
      state: 'unavailable',
      label: 'Device Sound',
      title:
        'Device sound was not approved when accepting this session. Unapproved audio capture remains disabled.',
      disabled: true,
      pressed: false,
    };
  } else if (sound.status === 'permission_denied') {
    deviceSound = {
      state: 'denied',
      label: 'Device Sound',
      title:
        sound.message ||
        'Device sound capture permission was denied.',
      disabled: true,
      pressed: false,
    };
  } else if (
    sound.status === 'unsupported' ||
    sound.status === 'source_disappeared'
  ) {
    deviceSound = {
      state: 'unavailable',
      label: 'Device Sound',
      title: sound.message || 'Device sound capture is unavailable on this device.',
      disabled: true,
      pressed: false,
    };
  } else if (isStartingDeviceSound || sound.status === 'starting') {
    deviceSound = {
      state: 'starting',
      label: 'Device Sound',
      title: 'Starting device sound capture...',
      disabled: true,
      pressed: false,
    };
  } else if (sound.active) {
    deviceSound = {
      state: 'active',
      label: 'Device Sound',
      title: 'Sharing device sound. Click to stop device sound.',
      disabled: false,
      pressed: true,
    };
  } else {
    deviceSound = {
      state: 'approved',
      label: 'Device Sound',
      title:
        'Device sound is approved and ready. Click to start sharing device sound.',
      disabled: false,
      pressed: false,
    };
  }

  let myScreen: ToolbarControlState<HostScreenUiState>;
  if (!screen.approved) {
    myScreen = {
      state: 'unavailable',
      label: 'My Screen',
      title: 'Screen sharing was not approved when accepting this session.',
      disabled: true,
      pressed: false,
    };
  } else if (screen.status === 'permission_denied') {
    myScreen = {
      state: 'denied',
      label: 'My Screen',
      title:
        screen.message ||
        'Screen capture permission was denied.',
      disabled: true,
      pressed: false,
    };
  } else if (
    screen.status === 'unsupported' ||
    screen.status === 'source_disappeared'
  ) {
    myScreen = {
      state: 'unavailable',
      label: 'My Screen',
      title: screen.message || 'Screen sharing is unavailable on this device.',
      disabled: true,
      pressed: false,
    };
  } else if (isStartingShare || screen.status === 'starting') {
    myScreen = {
      state: 'starting',
      label: 'Starting…',
      title: 'Starting screen capture...',
      disabled: true,
      pressed: false,
    };
  } else if (screen.active) {
    myScreen = {
      state: 'sharing',
      label: 'My Screen',
      title: 'Sharing your screen. Click to stop screen sharing.',
      disabled: false,
      pressed: true,
    };
  } else {
    myScreen = {
      state: 'approved',
      label: 'My Screen',
      title:
        'Screen sharing is approved and ready. Select a source and click Start Sharing.',
      disabled: false,
      pressed: false,
    };
  }

  return {
    myMic,
    deviceSound,
    myScreen,
    sourcePicker: {
      disabled: !screen.approved || isStartingShare,
      title: screen.approved
        ? 'Choose or switch the shared display or window'
        : 'Screen sharing was not approved for this session.',
    },
  };
}

export function computeViewerToolbarMediaControls(params: {
  hasRemoteMicTrack: boolean;
  hasRemoteDeviceAudioTrack: boolean;
  hasRemoteVideoTrack: boolean;
  guestPlayback: GuestPlaybackStateInput;
}): ViewerToolbarMediaControls {
  const {
    hasRemoteMicTrack,
    hasRemoteDeviceAudioTrack,
    hasRemoteVideoTrack,
    guestPlayback,
  } = params;

  const myMic: ToolbarControlState<'unavailable'> = {
    state: 'unavailable',
    label: 'My Mic',
    title:
      'Viewer microphone is currently unavailable. Audio transmission is Host-to-Viewer only.',
    disabled: true,
    pressed: false,
  };

  let peerMic: ToolbarControlState<PeerAudioUiState>;
  if (!hasRemoteMicTrack) {
    peerMic = {
      state: 'unavailable',
      label: 'Peer Mic',
      title: 'No remote microphone audio is currently being received from the host.',
      disabled: true,
      pressed: false,
    };
  } else if (guestPlayback.micMutedLocally) {
    peerMic = {
      state: 'muted',
      label: 'Peer Mic',
      title: "Host's microphone is muted locally. Click to unmute.",
      disabled: false,
      pressed: false,
    };
  } else {
    peerMic = {
      state: 'active',
      label: 'Peer Mic',
      title: "Receiving host's microphone audio. Click to mute locally.",
      disabled: false,
      pressed: true,
    };
  }

  let peerSound: ToolbarControlState<PeerAudioUiState>;
  if (!hasRemoteDeviceAudioTrack) {
    peerSound = {
      state: 'unavailable',
      label: 'Peer Sound',
      title: 'No remote device sound is currently being received from the host.',
      disabled: true,
      pressed: false,
    };
  } else if (guestPlayback.deviceAudioMutedLocally) {
    peerSound = {
      state: 'muted',
      label: 'Peer Sound',
      title: "Host's device sound is muted locally. Click to unmute.",
      disabled: false,
      pressed: false,
    };
  } else {
    peerSound = {
      state: 'active',
      label: 'Peer Sound',
      title: "Receiving host's device sound. Click to mute locally.",
      disabled: false,
      pressed: true,
    };
  }

  let peerScreen: ToolbarControlState<PeerScreenUiState>;
  if (!hasRemoteVideoTrack) {
    peerScreen = {
      state: 'unavailable',
      label: 'Peer Screen',
      title: 'No remote screen video is currently being received from the host.',
      disabled: true,
      pressed: false,
    };
  } else if (guestPlayback.videoPausedLocally) {
    peerScreen = {
      state: 'hidden',
      label: 'Peer Screen',
      title: 'Remote screen video is hidden locally. Click to show.',
      disabled: false,
      pressed: false,
    };
  } else {
    peerScreen = {
      state: 'received',
      label: 'Peer Screen',
      title: 'Receiving remote screen video. Click to hide locally.',
      disabled: false,
      pressed: true,
    };
  }

  return {
    myMic,
    peerMic,
    peerSound,
    peerScreen,
  };
}

export function shouldDismissOnOutsidePointerDown(params: {
  isOpen: boolean;
  insidePopup: boolean;
  insideToggleButton: boolean;
}): boolean {
  if (!params.isOpen) return false;
  if (params.insidePopup || params.insideToggleButton) return false;
  return true;
}

export function shouldDismissOnKeyDown(params: {
  isOpen: boolean;
  key: string;
}): boolean {
  return params.isOpen && params.key === 'Escape';
}
