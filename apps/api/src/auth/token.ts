import type { AccountProfile } from '@elm/protocol';

export interface SessionTokenPayload {
  readonly sub: string; // accountId
  readonly provider: string;
  readonly providerSubject: string;
  readonly displayName: string;
  readonly friendCode: string;
  readonly createdAt: string;
  readonly iat: number;
  readonly exp: number;
}

export interface OAuthStatePayload {
  readonly desktopRedirectUri: string;
  readonly desktopState: string;
  readonly iat: number;
  readonly exp: number;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function base64UrlDecodeToBytes(b64url: string): Uint8Array {
  const padded =
    b64url.replace(/-/g, '+').replace(/_/g, '/') +
    '==='.slice((b64url.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function base64UrlDecodeToString(b64url: string): string {
  return new TextDecoder().decode(base64UrlDecodeToBytes(b64url));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const effectiveSecret =
    secret && secret.trim().length > 0
      ? secret.trim()
      : 'elm-anydesk-default-dev-hmac-secret-change-in-prod';
  const keyBytes = new TextEncoder().encode(effectiveSecret);
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signPayload<T extends object>(
  payload: T,
  secret: string
): Promise<string> {
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const key = await importHmacKey(secret);
  const sigBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(encodedPayload)
  );
  const encodedSig = base64UrlEncodeBytes(new Uint8Array(sigBuffer));
  return `${encodedPayload}.${encodedSig}`;
}

async function verifyPayload<T extends { exp: number }>(
  token: string,
  secret: string
): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return null;

  try {
    const key = await importHmacKey(secret);
    const sigBytes = base64UrlDecodeToBytes(encodedSig);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes.buffer as ArrayBuffer,
      new TextEncoder().encode(encodedPayload)
    );
    if (!valid) return null;

    const parsed = JSON.parse(base64UrlDecodeToString(encodedPayload)) as T;
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof parsed.exp !== 'number' || parsed.exp <= nowSec) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function signSessionToken(
  account: AccountProfile,
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 7
): Promise<{ token: string; expiresAt: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + ttlSeconds;
  const payload: SessionTokenPayload = {
    sub: account.accountId,
    provider: account.provider,
    providerSubject: account.providerSubject,
    displayName: account.displayName,
    friendCode: account.friendCode,
    createdAt: account.createdAt,
    iat: nowSec,
    exp: expSec,
  };
  const token = await signPayload(payload, secret);
  return {
    token,
    expiresAt: new Date(expSec * 1000).toISOString(),
  };
}

export async function verifySessionToken(
  token: string,
  secret: string
): Promise<AccountProfile | null> {
  const payload = await verifyPayload<SessionTokenPayload>(token, secret);
  if (!payload) return null;
  return {
    accountId: payload.sub,
    provider: payload.provider,
    providerSubject: payload.providerSubject,
    displayName: payload.displayName,
    friendCode: payload.friendCode,
    createdAt: payload.createdAt,
  };
}

export async function signOAuthState(
  params: { desktopRedirectUri: string; desktopState: string },
  secret: string,
  ttlSeconds = 600
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: OAuthStatePayload = {
    desktopRedirectUri: params.desktopRedirectUri,
    desktopState: params.desktopState,
    iat: nowSec,
    exp: nowSec + ttlSeconds,
  };
  return signPayload(payload, secret);
}

export async function verifyOAuthState(
  stateToken: string,
  secret: string
): Promise<OAuthStatePayload | null> {
  return verifyPayload<OAuthStatePayload>(stateToken, secret);
}
