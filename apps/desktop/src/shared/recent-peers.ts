import { normalizeFriendCode, type LocalDeviceProfile } from '@elm/protocol';

export const MAX_PEER_NAME_LENGTH = 60;
export const MAX_PEER_EMAIL_LENGTH = 120;
export const MAX_PEER_PHONE_LENGTH = 40;
const MAX_RAW_CONTACT_FIELD_LENGTH = 512;

const GENERIC_PEER_NAMES = new Set([
  'elm device',
  'windows desktop',
  'unknown device',
]);

export interface RecentPeerEntry {
  readonly friendCode: string;
  readonly alias: string;
  readonly peerName?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly favorite: boolean;
  readonly lastConnectedAt: string;
}

export interface PeerContactCardPayload {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
}

export interface PeerContactCardFrame {
  readonly __elmControl: 'peer-contact-card';
  readonly sender: 'host' | 'guest';
  readonly name: string;
  readonly email: string;
  readonly phone: string;
}

export type PeerOnlineStatus = 'online' | 'offline' | 'unknown';

function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function sanitizePeerName(raw: string): string {
  const cleaned = stripControlChars(raw).slice(0, MAX_PEER_NAME_LENGTH);
  if (!cleaned || GENERIC_PEER_NAMES.has(cleaned.toLowerCase())) {
    return '';
  }
  return cleaned;
}

export function sanitizePeerEmail(raw: string): string {
  const cleaned = stripControlChars(raw).slice(0, MAX_PEER_EMAIL_LENGTH);
  if (!cleaned) return '';
  if (/\s/.test(cleaned)) return '';
  const atIndex = cleaned.indexOf('@');
  if (atIndex <= 0 || atIndex !== cleaned.lastIndexOf('@')) return '';
  const domain = cleaned.slice(atIndex + 1);
  if (!domain || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return '';
  }
  return cleaned;
}

export function sanitizePeerPhone(raw: string): string {
  const cleaned = stripControlChars(raw).slice(0, MAX_PEER_PHONE_LENGTH);
  if (!cleaned) return '';
  // Allow common international/local phone characters and require at least 3 digits
  if (!/^[0-9+\-().\s]+$/.test(cleaned)) return '';
  const digitCount = (cleaned.match(/\d/g) ?? []).length;
  if (digitCount < 3) return '';
  return cleaned;
}

/**
 * Builds the P2P contact card sent over an approved WebRTC DataChannel.
 * Any entered display name, email, and phone number are shared directly
 * peer-to-peer after session approval (never uploaded to Cloudflare).
 */
export function buildOutgoingPeerContactCard(
  profile: LocalDeviceProfile | null | undefined
): PeerContactCardPayload {
  return {
    name: sanitizePeerName(profile?.name ?? ''),
    email: sanitizePeerEmail(profile?.email ?? ''),
    phone: sanitizePeerPhone(profile?.phone ?? ''),
  };
}

/**
 * Validates and sanitizes an incoming WebRTC DataChannel `peer-contact-card` frame.
 * Returns null for malformed, mistyped, or oversized frames.
 */
export function sanitizePeerContactFrame(
  raw: unknown
): { readonly sender: 'host' | 'guest'; readonly contact: PeerContactCardPayload } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.__elmControl !== 'peer-contact-card') {
    return null;
  }
  if (obj.sender !== 'host' && obj.sender !== 'guest') {
    return null;
  }
  if (
    typeof obj.name !== 'string' ||
    typeof obj.email !== 'string' ||
    typeof obj.phone !== 'string'
  ) {
    return null;
  }
  if (
    obj.name.length > MAX_RAW_CONTACT_FIELD_LENGTH ||
    obj.email.length > MAX_RAW_CONTACT_FIELD_LENGTH ||
    obj.phone.length > MAX_RAW_CONTACT_FIELD_LENGTH
  ) {
    return null;
  }
  return {
    sender: obj.sender,
    contact: {
      name: sanitizePeerName(obj.name),
      email: sanitizePeerEmail(obj.email),
      phone: sanitizePeerPhone(obj.phone),
    },
  };
}

/**
 * Resolves the display label for a Recent Session card:
 * 1. Custom local alias (Rename)
 * 2. Peer-shared display name
 * 3. Device Code fallback
 */
export function resolveRecentPeerDisplayName(
  peer: Pick<RecentPeerEntry, 'friendCode' | 'alias' | 'peerName'>
): string {
  const customAlias = (peer.alias ?? '').trim();
  if (customAlias) return customAlias;
  const sharedName = sanitizePeerName(peer.peerName ?? '');
  if (sharedName) return sharedName;
  return peer.friendCode;
}

export function sortRecentPeers(
  peers: readonly RecentPeerEntry[]
): RecentPeerEntry[] {
  return [...peers].sort((a, b) => {
    if (a.favorite !== b.favorite) {
      return a.favorite ? -1 : 1;
    }
    const ta = Date.parse(a.lastConnectedAt) || 0;
    const tb = Date.parse(b.lastConnectedAt) || 0;
    if (ta !== tb) {
      return tb - ta;
    }
    return a.friendCode.localeCompare(b.friendCode);
  });
}

export function upsertSuccessfulPeerConnection(
  peers: readonly RecentPeerEntry[],
  params: {
    friendCode: string;
    defaultAlias?: string;
    connectedAt?: string;
  }
): RecentPeerEntry[] {
  const code = normalizeFriendCode(params.friendCode);
  if (!code) return sortRecentPeers(peers);

  const connectedAt = params.connectedAt || new Date().toISOString();
  const cleanedDefault = (params.defaultAlias ?? '').trim().slice(0, 60);
  const existingIdx = peers.findIndex(
    (p) => normalizeFriendCode(p.friendCode) === code
  );

  let next: RecentPeerEntry[];
  if (existingIdx >= 0) {
    const existing = peers[existingIdx];
    next = peers.map((p, idx) =>
      idx === existingIdx
        ? {
            ...existing,
            friendCode: code,
            alias: existing.alias || cleanedDefault,
            lastConnectedAt: connectedAt,
          }
        : p
    );
  } else {
    next = [
      ...peers,
      {
        friendCode: code,
        alias: cleanedDefault,
        favorite: false,
        lastConnectedAt: connectedAt,
      },
    ];
  }

  return sortRecentPeers(next);
}

export function toggleFavoritePeerEntry(
  peers: readonly RecentPeerEntry[],
  rawFriendCode: string
): RecentPeerEntry[] {
  const code = normalizeFriendCode(rawFriendCode);
  return sortRecentPeers(
    peers.map((p) =>
      normalizeFriendCode(p.friendCode) === code
        ? { ...p, favorite: !p.favorite }
        : p
    )
  );
}

export function renameRecentPeerEntry(
  peers: readonly RecentPeerEntry[],
  rawFriendCode: string,
  rawAlias: string
): RecentPeerEntry[] {
  const code = normalizeFriendCode(rawFriendCode);
  const cleanedAlias = rawAlias.trim().slice(0, 60);
  return sortRecentPeers(
    peers.map((p) =>
      normalizeFriendCode(p.friendCode) === code
        ? { ...p, alias: cleanedAlias }
        : p
    )
  );
}

export function removeRecentPeerEntry(
  peers: readonly RecentPeerEntry[],
  rawFriendCode: string
): RecentPeerEntry[] {
  const code = normalizeFriendCode(rawFriendCode);
  return sortRecentPeers(
    peers.filter((p) => normalizeFriendCode(p.friendCode) !== code)
  );
}

/**
 * Merges peer-shared contact metadata (display name, optional email, optional phone)
 * received over an approved WebRTC DataChannel. Never overwrites custom local `alias`
 * or `favorite` status.
 */
export function upsertRecentPeerContact(
  peers: readonly RecentPeerEntry[],
  params: {
    friendCode: string;
    peerName?: string;
    email?: string;
    phone?: string;
    connectedAt?: string;
  }
): RecentPeerEntry[] {
  const code = normalizeFriendCode(params.friendCode);
  if (!code) return sortRecentPeers(peers);

  const cleanedName =
    params.peerName !== undefined ? sanitizePeerName(params.peerName) : undefined;
  const cleanedEmail =
    params.email !== undefined ? sanitizePeerEmail(params.email) : undefined;
  const cleanedPhone =
    params.phone !== undefined ? sanitizePeerPhone(params.phone) : undefined;

  const existingIdx = peers.findIndex(
    (p) => normalizeFriendCode(p.friendCode) === code
  );

  let next: RecentPeerEntry[];
  if (existingIdx >= 0) {
    const existing = peers[existingIdx];
    const merged: RecentPeerEntry = {
      ...existing,
      friendCode: code,
      peerName:
        cleanedName !== undefined ? cleanedName || undefined : existing.peerName,
      email:
        cleanedEmail !== undefined ? cleanedEmail || undefined : existing.email,
      phone:
        cleanedPhone !== undefined ? cleanedPhone || undefined : existing.phone,
    };
    next = peers.map((p, idx) => (idx === existingIdx ? merged : p));
  } else {
    next = [
      ...peers,
      {
        friendCode: code,
        alias: '',
        ...(cleanedName ? { peerName: cleanedName } : {}),
        ...(cleanedEmail ? { email: cleanedEmail } : {}),
        ...(cleanedPhone ? { phone: cleanedPhone } : {}),
        favorite: false,
        lastConnectedAt: params.connectedAt || new Date().toISOString(),
      },
    ];
  }

  return sortRecentPeers(next);
}
