import {
  isValidFriendCode,
  normalizeFriendCode,
  PROTOCOL_VERSION,
  type AccountProfile,
  type ApiHealthResponse,
  type AuthSessionResponse,
  type HostMediaSelection,
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
          phase: 'phase-3-webrtc-media-and-datachannel-chat',
          protocolVersion: PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
        };
        return withCors(Response.json(payload));
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
        const res = await coordinator.fetch(
          new Request(
            'https://coordinator.internal/internal/presence/disconnect',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ accountId: account.accountId }),
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

      // 11. Disconnect Active Session: POST /sessions/disconnect
      if (request.method === 'POST' && url.pathname === '/sessions/disconnect') {
        const body = (await request.json().catch(() => ({}))) as {
          sessionId?: string;
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
