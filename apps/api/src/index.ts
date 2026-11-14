import {
  isValidFriendCode,
  normalizeFriendCode,
  PILOT_NETWORK_POLICY,
  PROTOCOL_VERSION,
  type AccountProfile,
  type ApiHealthResponse,
  type AuthSessionResponse,
  type HostMediaSelection,
  type PilotDownloadManifest,
  type ProtocolErrorCode,
} from '@elm/protocol';
import {
  GitHubOAuthProvider,
  type AuthProviderAdapter,
} from './auth/adapter.ts';
import {
  signOAuthState,
  signSessionToken,
  verifyOAuthState,
  verifySessionToken,
} from './auth/token.ts';
import {
  ensureAccountWithPermanentFriendCode,
  findAccountByFriendCode,
  findAccountById,
} from './db/accounts.ts';
import { SignalingCoordinator } from './coordinator.ts';

export { SignalingCoordinator };

export interface Env {
  DB: D1Database;
  SIGNALING_COORDINATOR: DurableObjectNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_HMAC_SECRET?: string;
  ENVIRONMENT?: string;
  INSTALLER_VERSION?: string;
  INSTALLER_FILENAME?: string;
  INSTALLER_DOWNLOAD_URL?: string;
  INSTALLER_SHA256?: string;
  PILOT_STUN_ONLY?: string;
  AUTO_UPDATE_ENABLED?: string;
}

export interface ApiWorkerDependencies {
  authAdapterFactory?: (env: Env) => AuthProviderAdapter;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function withCors(response: Response): Response {
  if (response.status === 101) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(
  status: number,
  code: ProtocolErrorCode,
  message: string
): Response {
  return withCors(
    Response.json(
      {
        error: code,
        message,
      },
      { status }
    )
  );
}

function isAllowedDesktopLoopbackRedirect(redirectUri: string): boolean {
  try {
    const parsed = new URL(redirectUri);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function getHmacSecret(env: Env): string {
  return (
    env.SESSION_HMAC_SECRET?.trim() ||
    'elm-anydesk-default-dev-hmac-secret-change-in-prod'
  );
}

async function authenticateRequest(
  request: Request,
  env: Env
): Promise<AccountProfile | null> {
  const url = new URL(request.url);
  const authHeader = request.headers.get('Authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : url.searchParams.get('token')?.trim() || '';

  if (!bearerToken) return null;

  const claims = await verifySessionToken(bearerToken, getHmacSecret(env));
  if (!claims) return null;

  const stored = await findAccountById(env.DB, claims.accountId);
  return stored;
}

function getCoordinatorStub(env: Env): DurableObjectStub {
  const id = env.SIGNALING_COORDINATOR.idFromName('global-pilot-coordinator');
  return env.SIGNALING_COORDINATOR.get(id);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPilotDownloadManifest(env: Env): PilotDownloadManifest {
  return {
    appName: 'Elm-AnyDesk',
    version: env.INSTALLER_VERSION?.trim() || '0.5.0-phase5',
    protocolVersion: PROTOCOL_VERSION,
    platform: 'win32-x64',
    installerFilename:
      env.INSTALLER_FILENAME?.trim() || 'Elm-AnyDesk-Setup-0.5.0-x64.exe',
    installerDownloadUrl:
      env.INSTALLER_DOWNLOAD_URL?.trim() ||
      '/releases/Elm-AnyDesk-Setup-0.5.0-x64.exe',
    installerSha256:
      env.INSTALLER_SHA256?.trim() ||
      '8e10060b69b58a97543036de78a7ef74772d66595f8409221730cac7516b7553',
    autoUpgradeEnabled: false,
    stunOnlyPilot: true,
    turnEnabled: false,
    paidServicesEnabled: false,
    stunServers: [...PILOT_NETWORK_POLICY.stunServers],
    restrictiveNetworkNotice:
      PILOT_NETWORK_POLICY.restrictiveNetworkLimitationMessage,
  };
}

function renderPilotDownloadPageHtml(manifest: PilotDownloadManifest): string {
  const safeFilename = escapeHtml(manifest.installerFilename);
  const safeUrl = escapeHtml(manifest.installerDownloadUrl);
  const safeVersion = escapeHtml(manifest.version);
  const safeSha256 = escapeHtml(manifest.installerSha256);
  const safeNotice = escapeHtml(manifest.restrictiveNetworkNotice);
  const stunList = manifest.stunServers
    .map((s) => `<code>${escapeHtml(s)}</code>`)
    .join(', ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Elm-AnyDesk — Windows 11 Pilot Installer Download</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    }
    body {
      margin: 0;
      padding: 32px 20px;
      background: #0b1120;
      color: #e2e8f0;
      line-height: 1.55;
    }
    .container {
      max-width: 880px;
      margin: 0 auto;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 28px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45);
    }
    h1 {
      margin-top: 0;
      color: #f8fafc;
      font-size: 1.75rem;
    }
    h2 {
      color: #93c5fd;
      font-size: 1.15rem;
      margin-top: 24px;
      border-bottom: 1px solid #1e293b;
      padding-bottom: 6px;
    }
    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 18px;
    }
    .badge {
      background: #1e293b;
      border: 1px solid #334155;
      color: #bfdbfe;
      font-size: 0.8rem;
      padding: 4px 10px;
      border-radius: 999px;
      font-weight: 600;
    }
    .download-box {
      background: #111c33;
      border: 1px solid #2563eb;
      border-radius: 10px;
      padding: 20px;
      margin: 18px 0;
    }
    .btn {
      display: inline-block;
      background: #2563eb;
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
      padding: 12px 22px;
      border-radius: 8px;
      margin-top: 8px;
    }
    .btn:hover {
      background: #1d4ed8;
    }
    .limitation-box {
      background: rgba(120, 53, 15, 0.25);
      border: 1px solid #d97706;
      color: #fde68a;
      border-radius: 8px;
      padding: 14px 16px;
      margin-top: 18px;
    }
    code, pre {
      font-family: "Cascadia Code", Consolas, monospace;
      background: #090e1a;
      padding: 2px 6px;
      border-radius: 4px;
      color: #bae6fd;
    }
    pre {
      padding: 12px;
      overflow-x: auto;
      border: 1px solid #1e293b;
    }
  </style>
</head>
<body>
  <main class="container">
    <h1>Elm-AnyDesk — Windows 11 Pilot Download</h1>
    <div class="badge-row">
      <span class="badge">Platform: Windows 11 (x64)</span>
      <span class="badge">Version: ${safeVersion}</span>
      <span class="badge">Protocol: ${escapeHtml(manifest.protocolVersion)}</span>
      <span class="badge">Zero-Bill STUN-Only Pilot</span>
      <span class="badge">TURN Disabled</span>
      <span class="badge">Auto-Upgrade Disabled</span>
    </div>

    <p>
      Consent-based 1:1 screen sharing, optional independent Microphone &amp; Device Audio, and a separate ephemeral private chat window for Windows 11.
    </p>

    <section class="download-box">
      <div><strong>Windows 11 x64 Installer Package:</strong> <code>${safeFilename}</code></div>
      <div style="margin-top: 6px; font-size: 0.9rem;">
        <strong>SHA-256 Checksum:</strong> <code>${safeSha256}</code>
      </div>
      <a class="btn" href="${safeUrl}" download="${safeFilename}">Download ${safeFilename}</a>
    </section>

    <section class="limitation-box">
      <strong>STUN-Only Zero-Bill Pilot Network Notice (No Paid TURN Relay):</strong>
      <p style="margin: 6px 0 0 0;">
        ${safeNotice}
      </p>
      <p style="margin: 6px 0 0 0; font-size: 0.88rem;">
        Configured STUN servers: ${stunList}
      </p>
    </section>

    <h2>Verify Installer Integrity (PowerShell)</h2>
    <pre>Get-FileHash .\\${safeFilename} -Algorithm SHA256</pre>

    <h2>Consent &amp; Security Guarantees</h2>
    <ul>
      <li><strong>Permanent Friend Code:</strong> Generated once per account; knowing a code never grants automatic access.</li>
      <li><strong>Granular Host Consent:</strong> Host A chooses Screen Video (Window or Display only — never webcam), Microphone Audio (default OFF), and Device Audio (default OFF) before accepting, and must click <em>Start Sharing</em> explicitly.</li>
      <li><strong>Separate Ephemeral Chat Window:</strong> Private chat runs in its own window with message previews disabled and zero database or disk persistence.</li>
      <li><strong>Non-Resumable Sessions:</strong> Disconnect, app close, or connection loss terminates the session permanently; reconnecting requires a fresh invite and fresh acceptance.</li>
    </ul>
  </main>
</body>
</html>`;
}

/**
 * Creates the Cloudflare Worker fetch handler.
 * Production entrypoint always uses GitHubOAuthProvider; tests can inject a test double
 * adapter without ever deploying test authentication.
 */
export function createApiWorker(deps?: ApiWorkerDependencies): ExportedHandler<Env> {
  const resolveAuthAdapter =
    deps?.authAdapterFactory ??
    ((env: Env) =>
      new GitHubOAuthProvider({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      }));

  return {
    async fetch(
      request: Request,
      env: Env,
      _ctx: ExecutionContext
    ): Promise<Response> {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);

      // 1. Health Check
      if (request.method === 'GET' && url.pathname === '/health') {
        const payload: ApiHealthResponse = {
          status: 'ok',
          phase: 'phase-5-staging-and-installer-pilot',
          protocolVersion: PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
        };
        return withCors(Response.json(payload));
      }

      // 1b. Pilot Installer Download Page & Manifest (GET /, GET /download, GET /download/manifest.json)
      if (
        request.method === 'GET' &&
        url.pathname === '/download/manifest.json'
      ) {
        const manifest = buildPilotDownloadManifest(env);
        return withCors(Response.json(manifest));
      }

      if (
        request.method === 'GET' &&
        (url.pathname === '/' || url.pathname === '/download')
      ) {
        const manifest = buildPilotDownloadManifest(env);
        if (request.headers.get('Accept')?.includes('application/json')) {
          return withCors(Response.json(manifest));
        }
        return withCors(
          new Response(renderPilotDownloadPageHtml(manifest), {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          })
        );
      }

      // 2. Desktop-Safe Browser Sign-In Start: GET /auth/login
      if (request.method === 'GET' && url.pathname === '/auth/login') {
        const authAdapter = resolveAuthAdapter(env);
        if (!authAdapter.isConfigured()) {
          return jsonError(
            503,
            'AUTH_PROVIDER_NOT_CONFIGURED',
            'OAuth provider credentials (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET) are not configured on the Worker.'
          );
        }

        const desktopRedirectUri =
          url.searchParams.get('redirect_uri') ||
          'http://127.0.0.1:45821/auth/callback';
        const desktopState = url.searchParams.get('desktop_state') || '';

        if (!isAllowedDesktopLoopbackRedirect(desktopRedirectUri)) {
          return jsonError(
            400,
            'UNAUTHORIZED',
            'redirect_uri must be a local loopback address (http://127.0.0.1:<port> or http://localhost:<port>).'
          );
        }

        const stateToken = await signOAuthState(
          { desktopRedirectUri, desktopState },
          getHmacSecret(env)
        );
        const callbackUrl = `${url.origin}/auth/callback`;
        const providerAuthUrl = authAdapter.buildAuthorizationUrl({
          state: stateToken,
          callbackUrl,
        });

        return Response.redirect(providerAuthUrl, 302);
      }

      // 3. Browser OAuth Callback: GET /auth/callback
      if (request.method === 'GET' && url.pathname === '/auth/callback') {
        const authAdapter = resolveAuthAdapter(env);
        if (!authAdapter.isConfigured()) {
          return jsonError(
            503,
            'AUTH_PROVIDER_NOT_CONFIGURED',
            'OAuth provider is not configured.'
          );
        }

        const code = url.searchParams.get('code')?.trim() || '';
        const stateToken = url.searchParams.get('state')?.trim() || '';
        if (!code || !stateToken) {
          return jsonError(
            400,
            'UNAUTHORIZED',
            'Missing OAuth code or state parameter.'
          );
        }

        const verifiedState = await verifyOAuthState(
          stateToken,
          getHmacSecret(env)
        );
        if (!verifiedState) {
          return jsonError(
            400,
            'UNAUTHORIZED',
            'Invalid or expired OAuth state parameter.'
          );
        }

        const callbackUrl = `${url.origin}/auth/callback`;
        const externalIdentity = await authAdapter.exchangeCodeForIdentity({
          code,
          callbackUrl,
        });

        // Create account and permanent Friend Code once in D1, or reuse existing code
        const account = await ensureAccountWithPermanentFriendCode(
          env.DB,
          externalIdentity
        );
        const { token, expiresAt } = await signSessionToken(
          account,
          getHmacSecret(env)
        );

        const sessionPayload: AuthSessionResponse = {
          token,
          account,
          expiresAt,
        };

        if (request.headers.get('Accept')?.includes('application/json')) {
          return withCors(Response.json(sessionPayload));
        }

        const loopbackTarget = new URL(verifiedState.desktopRedirectUri);
        loopbackTarget.searchParams.set('token', token);
        loopbackTarget.searchParams.set('expires_at', expiresAt);
        if (verifiedState.desktopState) {
          loopbackTarget.searchParams.set('state', verifiedState.desktopState);
        }

        return Response.redirect(loopbackTarget.toString(), 302);
      }

      // All endpoints below require a valid authenticated account
      const account = await authenticateRequest(request, env);
      if (!account) {
        return jsonError(
          401,
          'UNAUTHORIZED',
          'Valid authentication session token is required.'
        );
      }

      // 4. Current Account Identity & Permanent Friend Code: GET /auth/me
      if (request.method === 'GET' && url.pathname === '/auth/me') {
        return withCors(Response.json({ account }));
      }

      const coordinator = getCoordinatorStub(env);

      // 5. Authenticated Presence WebSocket Upgrade: GET /ws
      if (request.method === 'GET' && url.pathname === '/ws') {
        const wsHeaders = new Headers(request.headers);
        wsHeaders.set('X-Elm-Account-Json', JSON.stringify(account));
        return coordinator.fetch(
          new Request('https://coordinator.internal/internal/ws', {
            method: 'GET',
            headers: wsHeaders,
          })
        );
      }

      // 6. Presence Connect / Heartbeat: POST /presence/connect
      if (request.method === 'POST' && url.pathname === '/presence/connect') {
        const res = await coordinator.fetch(
          new Request('https://coordinator.internal/internal/presence/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account }),
          })
        );
        return withCors(res);
      }

      // 7. Presence Disconnect: POST /presence/disconnect
      if (request.method === 'POST' && url.pathname === '/presence/disconnect') {
        const body = (await request.json().catch(() => ({}))) as {
          reason?: string;
          subReason?: string;
        };
        const res = await coordinator.fetch(
          new Request(
            'https://coordinator.internal/internal/presence/disconnect',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accountId: account.accountId,
                reason: body.reason,
                subReason: body.subReason,
              }),
            }
          )
        );
        return withCors(res);
      }

      // 8. Presence & Session State Snapshot: GET /presence/state
      if (request.method === 'GET' && url.pathname === '/presence/state') {
        const res = await coordinator.fetch(
          new Request('https://coordinator.internal/internal/presence/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account }),
          })
        );
        return withCors(res);
      }

      // 9. Send Friend Code Invite: POST /invites
      if (request.method === 'POST' && url.pathname === '/invites') {
        const body = (await request.json().catch(() => ({}))) as {
          friendCode?: string;
        };
        const rawCode = body.friendCode ?? '';
        const normalizedCode = normalizeFriendCode(rawCode);

        if (!isValidFriendCode(normalizedCode)) {
          return jsonError(
            400,
            'INVALID_FRIEND_CODE_FORMAT',
            'Friend Code must match format ELM-XXXX-XXXX (using valid uppercase alphanumeric characters).'
          );
        }

        if (normalizedCode === account.friendCode) {
          return jsonError(
            400,
            'SELF_INVITE_NOT_ALLOWED',
            'You cannot send a session invite to your own Friend Code.'
          );
        }

        const targetAccount = await findAccountByFriendCode(
          env.DB,
          normalizedCode
        );
        if (!targetAccount) {
          return jsonError(
            404,
            'FRIEND_CODE_NOT_FOUND',
            'No account exists with that Friend Code.'
          );
        }

        const res = await coordinator.fetch(
          new Request('https://coordinator.internal/internal/invites/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requester: account,
              target: targetAccount,
            }),
          })
        );
        return withCors(res);
      }

      // 10. Accept or Decline Incoming Invite: POST /invites/:inviteId/respond
      const respondMatch = /^\/invites\/([^/]+)\/respond$/.exec(url.pathname);
      if (request.method === 'POST' && respondMatch) {
        const inviteId = decodeURIComponent(respondMatch[1]);
        const body = (await request.json().catch(() => ({}))) as {
          action?: 'accept' | 'decline';
          mediaSelection?: Partial<HostMediaSelection>;
        };

        if (body.action !== 'accept' && body.action !== 'decline') {
          return jsonError(
            400,
            'INVITE_NOT_FOUND',
            'Action must be "accept" or "decline".'
          );
        }

        const res = await coordinator.fetch(
          new Request('https://coordinator.internal/internal/invites/respond', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              responder: account,
              inviteId,
              action: body.action,
              mediaSelection: body.mediaSelection,
            }),
          })
        );
        return withCors(res);
      }

      // 11. Disconnect Active Session (Unified Idempotent Teardown): POST /sessions/disconnect
      if (request.method === 'POST' && url.pathname === '/sessions/disconnect') {
        const body = (await request.json().catch(() => ({}))) as {
          sessionId?: string;
          reason?: string;
          subReason?: string;
          detectionTimeMs?: number;
        };
        const res = await coordinator.fetch(
          new Request(
            'https://coordinator.internal/internal/sessions/disconnect',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                caller: account,
                sessionId: body.sessionId,
                reason: body.reason,
                subReason: body.subReason,
                detectionTimeMs: body.detectionTimeMs,
              }),
            }
          )
        );
        return withCors(res);
      }

      // 11b. Session Liveness Heartbeat: POST /sessions/heartbeat
      if (request.method === 'POST' && url.pathname === '/sessions/heartbeat') {
        const body = (await request.json().catch(() => ({}))) as {
          sessionId?: string;
          timestampIso?: string;
        };
        const res = await coordinator.fetch(
          new Request(
            'https://coordinator.internal/internal/sessions/heartbeat',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                caller: account,
                sessionId: body.sessionId,
                timestampIso: body.timestampIso,
              }),
            }
          )
        );
        return withCors(res);
      }

      // 11c. Session Liveness Check: POST /sessions/check-liveness
      if (
        request.method === 'POST' &&
        url.pathname === '/sessions/check-liveness'
      ) {
        const body = (await request.json().catch(() => ({}))) as {
          sessionId?: string;
          nowIso?: string;
          livenessTimeoutMs?: number;
        };
        const res = await coordinator.fetch(
          new Request(
            'https://coordinator.internal/internal/sessions/check-liveness',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                caller: account,
                sessionId: body.sessionId,
                nowIso: body.nowIso,
                livenessTimeoutMs: body.livenessTimeoutMs,
              }),
            }
          )
        );
        return withCors(res);
      }

      // 12. Session Join / Signaling Gate: POST /sessions/join or POST /sessions/signal
      if (
        request.method === 'POST' &&
        (url.pathname === '/sessions/join' ||
          url.pathname === '/sessions/signal')
      ) {
        const body = (await request.json().catch(() => ({}))) as {
          sessionId?: string;
          friendCode?: string;
          signalType?: string;
          payload?: unknown;
        };
        const res = await coordinator.fetch(
          new Request(
            'https://coordinator.internal/internal/sessions/join-or-signal',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                caller: account,
                sessionId: body.sessionId,
                friendCode: body.friendCode,
                signalType: body.signalType,
                payload: body.payload,
              }),
            }
          )
        );
        return withCors(res);
      }

      // 13. Poll WebRTC Signals for Approved Participant: GET /sessions/signals
      if (request.method === 'GET' && url.pathname === '/sessions/signals') {
        const sessionId = url.searchParams.get('sessionId') || undefined;
        const afterSeq = Number(url.searchParams.get('afterSeq') || '0');
        const res = await coordinator.fetch(
          new Request(
            'https://coordinator.internal/internal/sessions/signals',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                caller: account,
                sessionId,
                afterSeq,
              }),
            }
          )
        );
        return withCors(res);
      }

      return withCors(
        Response.json(
          {
            error: 'Not Found',
            message: 'Elm-AnyDesk API Phase 3.',
          },
          { status: 404 }
        )
      );
    },
  };
}

// Default deployed entrypoint strictly uses real GitHubOAuthProvider (never deploys test auth)
export default createApiWorker();
