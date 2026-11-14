import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FRIEND_CODE_REGEX,
  type AccountProfile,
  type ApprovedSessionSummary,
  type AuthSessionResponse,
  type InviteSummary,
  type PresenceStateSnapshot,
} from '@elm/protocol';
import {
  GitHubOAuthProvider,
  type AuthProviderAdapter,
  type VerifiedExternalIdentity,
} from '../src/auth/adapter.ts';
import { SignalingCoordinator } from '../src/coordinator.ts';
import { createApiWorker, type Env } from '../src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Real SQLite-backed D1Database test harness using Node 24's built-in `node:sqlite`.
 */
function createSqliteD1Database(): D1Database {
  const db = new DatabaseSync(':memory:');
  const migrationSql = fs.readFileSync(
    path.resolve(
      __dirname,
      '../migrations/0001_accounts_and_friend_codes.sql'
    ),
    'utf8'
  );
  db.exec(migrationSql);

  const createBoundStatement = (sql: string, boundValues: unknown[] = []) => {
    const normalizeSql = sql.replace(/\?(\d+)/g, '?');
    return {
      bind(...values: unknown[]) {
        return createBoundStatement(sql, values);
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const stmt = db.prepare(normalizeSql);
        const row = stmt.get(...(boundValues as never[])) as T | undefined;
        return row ?? null;
      },
      async run(): Promise<D1Result> {
        const stmt = db.prepare(normalizeSql);
        stmt.run(...(boundValues as never[]));
        return {
          success: true,
          meta: {} as D1Meta,
          results: [],
        };
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const stmt = db.prepare(normalizeSql);
        const rows = stmt.all(...(boundValues as never[])) as T[];
        return {
          success: true,
          meta: {} as D1Meta,
          results: rows,
        };
      },
      async raw<T = unknown[]>(): Promise<T[]> {
        return [];
      },
    } as unknown as D1PreparedStatement;
  };

  return {
    prepare(query: string) {
      return createBoundStatement(query);
    },
    async batch<T = unknown>(
      statements: D1PreparedStatement[]
    ): Promise<D1Result<T>[]> {
      const out: D1Result<T>[] = [];
      for (const s of statements) {
        out.push(await s.all<T>());
      }
      return out;
    },
    async exec(query: string): Promise<D1ExecResult> {
      db.exec(query);
      return { count: 1, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}

/**
 * Real SQLite-backed DurableObjectNamespace harness for SignalingCoordinator.
 */
function createSqliteCoordinatorNamespace(): DurableObjectNamespace {
  const instances = new Map<string, SignalingCoordinator>();

  const getOrCreateCoordinator = (name: string): SignalingCoordinator => {
    let instance = instances.get(name);
    if (!instance) {
      const sqlite = new DatabaseSync(':memory:');
      const sqlStorage = {
        exec<T extends Record<string, SqlStorageValue>>(
          query: string,
          ...bindings: unknown[]
        ) {
          if (bindings.length === 0) {
            const trimmed = query.trim();
            if (/^SELECT\b/i.test(trimmed)) {
              const stmt = sqlite.prepare(trimmed);
              const rows = stmt.all() as T[];
              return {
                toArray: () => rows,
              };
            }
            sqlite.exec(query);
            return {
              toArray: () => [] as T[],
            };
          }

          const stmt = sqlite.prepare(query);
          if (/^\s*SELECT\b/i.test(query)) {
            const rows = stmt.all(...(bindings as never[])) as T[];
            return {
              toArray: () => rows,
            };
          }
          stmt.run(...(bindings as never[]));
          return {
            toArray: () => [] as T[],
          };
        },
      };

      const fakeState = {
        storage: {
          sql: sqlStorage,
        },
      } as unknown as DurableObjectState;

      instance = new SignalingCoordinator(fakeState, {});
      instances.set(name, instance);
    }
    return instance;
  };

  return {
    idFromName(name: string): DurableObjectId {
      return {
        toString: () => name,
        equals: (other: DurableObjectId) => other.toString() === name,
        name,
      } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      const coordinator = getOrCreateCoordinator(id.toString());
      return {
        id,
        name: id.toString(),
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const req =
            input instanceof Request ? input : new Request(input, init);
          return coordinator.fetch(req);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

/**
 * Isolated Test Double Auth Provider (never deployed in production index.ts).
 */
class TestDoubleAuthProvider implements AuthProviderAdapter {
  public readonly providerName = 'github-test-double';
  private readonly usersByCode = new Map<string, VerifiedExternalIdentity>();

  constructor(identities: Record<string, VerifiedExternalIdentity>) {
    for (const [code, id] of Object.entries(identities)) {
      this.usersByCode.set(code, id);
    }
  }

  public isConfigured(): boolean {
    return true;
  }

  public buildAuthorizationUrl(params: {
    state: string;
    callbackUrl: string;
  }): string {
    const u = new URL('https://auth.example.test/authorize');
    u.searchParams.set('state', params.state);
    u.searchParams.set('redirect_uri', params.callbackUrl);
    return u.toString();
  }

  public async exchangeCodeForIdentity(params: {
    code: string;
    callbackUrl: string;
  }): Promise<VerifiedExternalIdentity> {
    const found = this.usersByCode.get(params.code);
    if (!found) {
      throw new Error(`Invalid test auth code: ${params.code}`);
    }
    return found;
  }
}

function createTestEnv(): Env {
  return {
    DB: createSqliteD1Database(),
    SIGNALING_COORDINATOR: createSqliteCoordinatorNamespace(),
    SESSION_HMAC_SECRET: 'test-only-hmac-secret-key-for-unit-tests',
  };
}

const dummyCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function signInViaBrowserFlow(
  worker: ExportedHandler<Env>,
  env: Env,
  oauthCode: string
): Promise<AuthSessionResponse> {
  const loginRes = await worker.fetch!(
    new Request(
      'https://api.elm.local/auth/login?redirect_uri=http://127.0.0.1:49152/auth/callback&desktop_state=xyz123'
    ),
    env,
    dummyCtx
  );
  assert.equal(loginRes.status, 302);
  const location = loginRes.headers.get('Location');
  assert.ok(location);

  const authUrl = new URL(location);
  const stateParam = authUrl.searchParams.get('state');
  assert.ok(stateParam);

  const callbackRes = await worker.fetch!(
    new Request(
      `https://api.elm.local/auth/callback?code=${encodeURIComponent(
        oauthCode
      )}&state=${encodeURIComponent(stateParam)}`,
      {
        headers: {
          Accept: 'application/json',
        },
      }
    ),
    env,
    dummyCtx
  );
  assert.equal(callbackRes.status, 200);
  return (await callbackRes.json()) as AuthSessionResponse;
}

test('1. Real GitHubOAuthProvider fails closed when unconfigured and exchanges OAuth code when configured', async () => {
  const unconfigured = new GitHubOAuthProvider({});
  assert.equal(unconfigured.isConfigured(), false);

  const env = createTestEnv();
  const prodWorker = createApiWorker();
  const res = await prodWorker.fetch!(
    new Request(
      'https://api.elm.local/auth/login?redirect_uri=http://127.0.0.1:45821/auth/callback'
    ),
    env,
    dummyCtx
  );
  assert.equal(res.status, 503);
  const errBody = (await res.json()) as { error: string };
  assert.equal(errBody.error, 'AUTH_PROVIDER_NOT_CONFIGURED');

  // Verify GitHubOAuthProvider with mocked fetch
  const configured = new GitHubOAuthProvider({
    clientId: 'gh-client-id-123',
    clientSecret: 'gh-secret-xyz',
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes('/login/oauth/access_token')) {
        return Response.json({ access_token: 'gho_mock_token_999' });
      }
      if (url.includes('api.github.com/user')) {
        return Response.json({
          id: 424242,
          login: 'yashith03',
          name: 'Yashith',
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });

  assert.equal(configured.isConfigured(), true);
  const authUrl = configured.buildAuthorizationUrl({
    state: 'signed-state',
    callbackUrl: 'https://api.elm.local/auth/callback',
  });
  assert.ok(authUrl.startsWith('https://github.com/login/oauth/authorize'));
  assert.ok(authUrl.includes('client_id=gh-client-id-123'));

  const identity = await configured.exchangeCodeForIdentity({
    code: 'sample-gh-code',
    callbackUrl: 'https://api.elm.local/auth/callback',
  });
  assert.deepEqual(identity, {
    provider: 'github',
    providerSubject: '424242',
    displayName: 'Yashith',
  });
});

test('2. Permanent Friend Code is created once in D1 and reused across restarts and repeated sign-ins', async () => {
  const env = createTestEnv();
  let aliceDisplayName = 'Alice (Initial)';

  const worker = createApiWorker({
    authAdapterFactory: () => ({
      providerName: 'github',
      isConfigured: () => true,
      buildAuthorizationUrl: ({ state, callbackUrl }) =>
        `https://auth.example.test/authorize?state=${state}&redirect_uri=${callbackUrl}`,
      exchangeCodeForIdentity: async () => ({
        provider: 'github',
        providerSubject: 'github-user-1001',
        displayName: aliceDisplayName,
      }),
    }),
  });

  const firstSession = await signInViaBrowserFlow(worker, env, 'code-1');
  assert.match(firstSession.account.friendCode, FRIEND_CODE_REGEX);
  assert.equal(firstSession.account.displayName, 'Alice (Initial)');

  // Simulate app restart and second sign-in with updated profile name
  aliceDisplayName = 'Alice (Renamed)';
  const secondSession = await signInViaBrowserFlow(worker, env, 'code-2');

  assert.equal(
    secondSession.account.accountId,
    firstSession.account.accountId,
    'Account ID must remain identical across sign-ins'
  );
  assert.equal(
    secondSession.account.friendCode,
    firstSession.account.friendCode,
    'Permanent Friend Code must be reused and never regenerated'
  );
  assert.equal(secondSession.account.displayName, 'Alice (Renamed)');

  // Verify /auth/me returns the same stored account & Friend Code
  const meRes = await worker.fetch!(
    new Request('https://api.elm.local/auth/me', {
      headers: { Authorization: `Bearer ${secondSession.token}` },
    }),
    env,
    dummyCtx
  );
  assert.equal(meRes.status, 200);
  const meBody = (await meRes.json()) as { account: AccountProfile };
  assert.equal(meBody.account.friendCode, firstSession.account.friendCode);
});

test('3. Invite flow edge cases: invalid codes, self-invites, offline owners, duplicate requests, owner-only accept, simultaneous accepts, 1:1 session limit, and signaling/join security gates', async () => {
  const env = createTestEnv();
  const testAuth = new TestDoubleAuthProvider({
    'code-alice': {
      provider: 'github',
      providerSubject: 'sub-alice',
      displayName: 'Alice Host',
    },
    'code-bob': {
      provider: 'github',
      providerSubject: 'sub-bob',
      displayName: 'Bob Guest',
    },
    'code-charlie': {
      provider: 'github',
      providerSubject: 'sub-charlie',
      displayName: 'Charlie Peer',
    },
  });

  const worker = createApiWorker({
    authAdapterFactory: () => testAuth,
  });

  const alice = await signInViaBrowserFlow(worker, env, 'code-alice');
  const bob = await signInViaBrowserFlow(worker, env, 'code-bob');
  const charlie = await signInViaBrowserFlow(worker, env, 'code-charlie');

  const authHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  // --- SECURITY INVARIANT A: No signaling admitted while idle (before any invite/acceptance) ---
  const idleSignalRes = await worker.fetch!(
    new Request('https://api.elm.local/sessions/signal', {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify({ signalType: 'webrtc:offer' }),
    }),
    env,
    dummyCtx
  );
  assert.equal(idleSignalRes.status, 403);
  assert.equal(
    ((await idleSignalRes.json()) as { error: string }).error,
    'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE'
  );

  // --- EDGE CASE 1: Invalid Friend Code format ---
  const invalidFormatRes = await worker.fetch!(
    new Request('https://api.elm.local/invites', {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify({ friendCode: 'BAD-CODE-123' }),
    }),
    env,
    dummyCtx
  );
  assert.equal(invalidFormatRes.status, 400);
  assert.equal(
    ((await invalidFormatRes.json()) as { error: string }).error,
    'INVALID_FRIEND_CODE_FORMAT'
  );

  // --- EDGE CASE 2: Non-existent valid Friend Code ---
  const notFoundRes = await worker.fetch!(
    new Request('https://api.elm.local/invites', {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify({ friendCode: 'ELM-2345-6789' }),
    }),
    env,
    dummyCtx
  );
  assert.equal(notFoundRes.status, 404);
  assert.equal(
    ((await notFoundRes.json()) as { error: string }).error,
    'FRIEND_CODE_NOT_FOUND'
  );

  // --- EDGE CASE 3: Self-invite rejected ---
  const selfInviteRes = await worker.fetch!(
    new Request('https://api.elm.local/invites', {
      method: 'POST',
      headers: authHeaders(alice.token),
      body: JSON.stringify({ friendCode: alice.account.friendCode }),
    }),
    env,
    dummyCtx
  );
  assert.equal(selfInviteRes.status, 400);
  assert.equal(
    ((await selfInviteRes.json()) as { error: string }).error,
    'SELF_INVITE_NOT_ALLOWED'
  );

  // --- EDGE CASE 4: Offline owner rejected ---
  const offlineInviteRes = await worker.fetch!(
    new Request('https://api.elm.local/invites', {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify({ friendCode: alice.account.friendCode }),
    }),
    env,
    dummyCtx
  );
  assert.equal(offlineInviteRes.status, 409);
  assert.equal(
    ((await offlineInviteRes.json()) as { error: string }).error,
    'TARGET_OFFLINE'
  );

  // Bring Alice, Bob, and Charlie online in Presence
  for (const peer of [alice, bob, charlie]) {
    const presRes = await worker.fetch!(
      new Request('https://api.elm.local/presence/connect', {
        method: 'POST',
        headers: authHeaders(peer.token),
      }),
      env,
      dummyCtx
    );
    assert.equal(presRes.status, 200);
  }

  // Bob sends a valid invite to Alice
  const createInviteRes = await worker.fetch!(
    new Request('https://api.elm.local/invites', {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify({
        friendCode: alice.account.friendCode.toLowerCase(),
      }),
    }),
    env,
    dummyCtx
  );
  assert.equal(createInviteRes.status, 201);
  const { invite: bobInvite } = (await createInviteRes.json()) as {
    invite: InviteSummary;
  };
  assert.equal(bobInvite.requesterAccountId, bob.account.accountId);
  assert.equal(bobInvite.requesterDisplayName, 'Bob Guest');
  assert.equal(bobInvite.targetAccountId, alice.account.accountId);
  assert.equal(bobInvite.status, 'pending');

  // --- EDGE CASE 5: Duplicate invite request rejected ---
  const dupInviteRes = await worker.fetch!(
    new Request('https://api.elm.local/invites', {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify({ friendCode: alice.account.friendCode }),
    }),
    env,
    dummyCtx
  );
  assert.equal(dupInviteRes.status, 409);
  assert.equal(
    ((await dupInviteRes.json()) as { error: string }).error,
    'DUPLICATE_PENDING_INVITE'
  );

  // --- EDGE CASE 6: Second concurrent outgoing invite from Bob to Charlie rejected ---
  const secondOutgoingRes = await worker.fetch!(
    new Request('https://api.elm.local/invites', {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify({ friendCode: charlie.account.friendCode }),
    }),
    env,
    dummyCtx
  );
  assert.equal(secondOutgoingRes.status, 409);
  assert.equal(
    ((await secondOutgoingRes.json()) as { error: string }).error,
    'OUTGOING_INVITE_ALREADY_PENDING'
  );

  // --- SECURITY INVARIANT B: No signaling admitted while invite is pending (before acceptance) ---
  const pendingSignalRes = await worker.fetch!(
    new Request('https://api.elm.local/sessions/signal', {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify({ signalType: 'webrtc:offer' }),
    }),
    env,
    dummyCtx
  );
  assert.equal(pendingSignalRes.status, 403);
  assert.equal(
    ((await pendingSignalRes.json()) as { error: string }).error,
    'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE'
  );

  // --- EDGE CASE 7: Accept only from intended owner (Bob and Charlie cannot accept Alice's invite) ---
  for (const nonOwner of [bob, charlie]) {
    const hijackAcceptRes = await worker.fetch!(
      new Request(
        `https://api.elm.local/invites/${bobInvite.inviteId}/respond`,
        {
          method: 'POST',
          headers: authHeaders(nonOwner.token),
          body: JSON.stringify({ action: 'accept' }),
        }
      ),
      env,
      dummyCtx
    );
    assert.equal(hijackAcceptRes.status, 403);
    assert.equal(
      ((await hijackAcceptRes.json()) as { error: string }).error,
      'NOT_INVITE_OWNER'
    );
  }

  // Charlie also sends an invite to Alice so Alice has 2 incoming pending invites (from Bob and Charlie)
  const charlieInviteRes = await worker.fetch!(
    new Request('https://api.elm.local/invites', {
      method: 'POST',
      headers: authHeaders(charlie.token),
      body: JSON.stringify({ friendCode: alice.account.friendCode }),
    }),
    env,
    dummyCtx
  );
  assert.equal(charlieInviteRes.status, 201);
  const { invite: charlieInvite } = (await charlieInviteRes.json()) as {
    invite: InviteSummary;
  };

  // Verify Alice's presence snapshot shows both incoming invites with requester identities
  const aliceStateRes = await worker.fetch!(
    new Request('https://api.elm.local/presence/state', {
      headers: authHeaders(alice.token),
    }),
    env,
    dummyCtx
  );
  const { snapshot: aliceSnapshot } = (await aliceStateRes.json()) as {
    snapshot: PresenceStateSnapshot;
  };
  assert.equal(aliceSnapshot.incomingInvites.length, 2);

  // --- EDGE CASE 8: Alice accepts Bob's invite with independent media selection (Screen Video ON, Mic OFF, Device Audio ON) ---
  const acceptBobRes = await worker.fetch!(
    new Request(
      `https://api.elm.local/invites/${bobInvite.inviteId}/respond`,
      {
        method: 'POST',
        headers: authHeaders(alice.token),
        body: JSON.stringify({
          action: 'accept',
          mediaSelection: {
            screenVideo: true,
            microphoneAudio: false,
            deviceAudio: true,
          },
        }),
      }
    ),
    env,
    dummyCtx
  );
  assert.equal(acceptBobRes.status, 200);
  const { session: approvedSession } = (await acceptBobRes.json()) as {
    invite: InviteSummary;
    session: ApprovedSessionSummary;
  };
  assert.ok(approvedSession.sessionId);
  assert.equal(approvedSession.hostAccountId, alice.account.accountId);
  assert.equal(approvedSession.guestAccountId, bob.account.accountId);
  assert.deepEqual(approvedSession.hostMediaSelection, {
    screenVideo: true,
    microphoneAudio: false,
    deviceAudio: true,
  });

  // --- EDGE CASE 9: Simultaneous / second accept rejected & one active 1:1 session per user enforced ---
  const acceptCharlieRes = await worker.fetch!(
    new Request(
      `https://api.elm.local/invites/${charlieInvite.inviteId}/respond`,
      {
        method: 'POST',
        headers: authHeaders(alice.token),
        body: JSON.stringify({ action: 'accept' }),
      }
    ),
    env,
    dummyCtx
  );
  assert.equal(acceptCharlieRes.status, 409);

  // Duplicate accept on Bob's already accepted invite is also rejected
  const duplicateAcceptBobRes = await worker.fetch!(
    new Request(
      `https://api.elm.local/invites/${bobInvite.inviteId}/respond`,
      {
        method: 'POST',
        headers: authHeaders(alice.token),
        body: JSON.stringify({ action: 'accept' }),
      }
    ),
    env,
    dummyCtx
  );
  assert.equal(duplicateAcceptBobRes.status, 409);
  assert.equal(
    ((await duplicateAcceptBobRes.json()) as { error: string }).error,
    'INVITE_ALREADY_RESOLVED'
  );

  // Charlie cannot send a new invite to Alice while Alice is in an active session with Bob
  const inviteBusyAliceRes = await worker.fetch!(
    new Request('https://api.elm.local/invites', {
      method: 'POST',
      headers: authHeaders(charlie.token),
      body: JSON.stringify({ friendCode: alice.account.friendCode }),
    }),
    env,
    dummyCtx
  );
  assert.equal(inviteBusyAliceRes.status, 409);
  assert.equal(
    ((await inviteBusyAliceRes.json()) as { error: string }).error,
    'USER_ALREADY_IN_ACTIVE_SESSION'
  );

  // --- SECURITY INVARIANT C: Knowing the Friend Code (and even sessionId) CANNOT join an approved session ---
  const charlieJoinByCodeRes = await worker.fetch!(
    new Request('https://api.elm.local/sessions/join', {
      method: 'POST',
      headers: authHeaders(charlie.token),
      body: JSON.stringify({
        friendCode: alice.account.friendCode,
        sessionId: approvedSession.sessionId,
      }),
    }),
    env,
    dummyCtx
  );
  assert.equal(charlieJoinByCodeRes.status, 403);
  assert.equal(
    ((await charlieJoinByCodeRes.json()) as { error: string }).error,
    'UNAUTHORIZED_SESSION_PARTICIPANT'
  );

  const charlieSignalByCodeRes = await worker.fetch!(
    new Request('https://api.elm.local/sessions/signal', {
      method: 'POST',
      headers: authHeaders(charlie.token),
      body: JSON.stringify({
        friendCode: alice.account.friendCode,
      }),
    }),
    env,
    dummyCtx
  );
  assert.equal(charlieSignalByCodeRes.status, 403);
  assert.equal(
    ((await charlieSignalByCodeRes.json()) as { error: string }).error,
    'UNAUTHORIZED_SESSION_PARTICIPANT'
  );

  // Disconnect active session and verify non-resumable clean state
  const disconnectRes = await worker.fetch!(
    new Request('https://api.elm.local/sessions/disconnect', {
      method: 'POST',
      headers: authHeaders(alice.token),
      body: JSON.stringify({ sessionId: approvedSession.sessionId }),
    }),
    env,
    dummyCtx
  );
  assert.equal(disconnectRes.status, 200);

  // After disconnect, signaling on the ended sessionId is blocked again
  const postEndSignalRes = await worker.fetch!(
    new Request('https://api.elm.local/sessions/signal', {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify({ sessionId: approvedSession.sessionId }),
    }),
    env,
    dummyCtx
  );
  assert.equal(postEndSignalRes.status, 403);
  assert.equal(
    ((await postEndSignalRes.json()) as { error: string }).error,
    'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE'
  );
});
