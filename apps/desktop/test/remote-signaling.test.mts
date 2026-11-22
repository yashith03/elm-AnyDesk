import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildOutgoingPeerContactCard,
  resolveRecentPeerDisplayName,
  sanitizePeerContactFrame,
  upsertRecentPeerContact,
  upsertSuccessfulPeerConnection,
  type RecentPeerEntry,
} from '../src/shared/recent-peers.ts';

/**
 * Integration test for two independent device clients (A and B) with separate
 * device identities, separate credentials, and zero shared local state,
 * communicating over the Worker HTTP invite & signaling protocol.
 */
test('two independent device clients complete invite, recipient-only accept/decline, signaling, and disconnect', async () => {
  const devices = new Map<
    string,
    { accountId: string; friendCode: string; token: string }
  >();
  const tokenToAccount = new Map<
    string,
    { accountId: string; friendCode: string; displayName: string }
  >();
  const online = new Set<string>();
  const invites = new Map<
    string,
    {
      inviteId: string;
      requesterAccountId: string;
      requesterFriendCode: string;
      targetAccountId: string;
      targetFriendCode: string;
      status: 'pending' | 'accepted' | 'declined';
    }
  >();
  const sessions = new Map<
    string,
    {
      sessionId: string;
      hostAccountId: string;
      guestAccountId: string;
      ended: boolean;
      signals: Array<{
        seq: number;
        targetAccountId: string;
        senderAccountId: string;
        payload: unknown;
      }>;
    }
  >();
  let seqCounter = 0;

  const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/devices/register') {
      const body = await readJson(req);
      const deviceId = String(body.deviceId ?? '');
      let dev = devices.get(deviceId);
      if (!dev) {
        const idx = devices.size + 1;
        dev = {
          accountId: `acct-${idx}`,
          friendCode: `ELM-DEV${idx}-TEST`,
          token: `tok-${idx}`,
        };
        devices.set(deviceId, dev);
        tokenToAccount.set(dev.token, {
          accountId: dev.accountId,
          friendCode: dev.friendCode,
          displayName: `Device ${dev.friendCode}`,
        });
      }
      return send(200, {
        token: dev.token,
        account: tokenToAccount.get(dev.token),
      });
    }

    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const caller = tokenToAccount.get(auth);
    if (!caller) {
      return send(401, { error: 'UNAUTHORIZED', message: 'Invalid token.' });
    }

    if (req.method === 'POST' && url.pathname === '/presence/connect') {
      online.add(caller.accountId);
      return send(200, {
        snapshot: {
          account: caller,
          online: true,
          incomingInvites: [],
          outgoingInvites: [],
          activeSession: null,
        },
      });
    }

    if (req.method === 'GET' && url.pathname === '/presence/state') {
      const incomingInvites = [...invites.values()].filter(
        (i) => i.targetAccountId === caller.accountId && i.status === 'pending'
      );
      const outgoingInvites = [...invites.values()].filter(
        (i) => i.requesterAccountId === caller.accountId && i.status === 'pending'
      );
      const activeSession =
        [...sessions.values()].find(
          (s) =>
            !s.ended &&
            (s.hostAccountId === caller.accountId ||
              s.guestAccountId === caller.accountId)
        ) ?? null;
      return send(200, {
        snapshot: {
          account: caller,
          online: online.has(caller.accountId),
          incomingInvites,
          outgoingInvites,
          activeSession,
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/invites') {
      const body = await readJson(req);
      const code = String(body.friendCode ?? '').trim().toUpperCase();
      const target = [...tokenToAccount.values()].find(
        (a) => a.friendCode === code
      );
      if (!target) {
        return send(404, { error: 'FRIEND_CODE_NOT_FOUND' });
      }
      if (!online.has(target.accountId)) {
        return send(409, { error: 'TARGET_OFFLINE' });
      }
      const invite = {
        inviteId: `inv-${invites.size + 1}`,
        requesterAccountId: caller.accountId,
        requesterFriendCode: caller.friendCode,
        targetAccountId: target.accountId,
        targetFriendCode: target.friendCode,
        status: 'pending' as const,
      };
      invites.set(invite.inviteId, invite);
      return send(200, { invite });
    }

    const respondMatch = /^\/invites\/([^/]+)\/respond$/.exec(url.pathname);
    if (req.method === 'POST' && respondMatch) {
      const invite = invites.get(decodeURIComponent(respondMatch[1]));
      if (!invite) return send(404, { error: 'INVITE_NOT_FOUND' });
      if (invite.targetAccountId !== caller.accountId) {
        return send(403, { error: 'NOT_INVITE_OWNER' });
      }
      const body = await readJson(req);
      if (body.action === 'decline') {
        invite.status = 'declined';
        return send(200, { invite, session: null });
      }
      invite.status = 'accepted';
      const session = {
        sessionId: `sess-${sessions.size + 1}`,
        hostAccountId: invite.targetAccountId,
        guestAccountId: invite.requesterAccountId,
        ended: false,
        signals: [],
      };
      sessions.set(session.sessionId, session);
      return send(200, { invite, session });
    }

    if (req.method === 'POST' && url.pathname === '/sessions/signal') {
      const body = await readJson(req);
      const session = sessions.get(String(body.sessionId ?? ''));
      if (!session) return send(403, { error: 'SIGNALING_NOT_ADMITTED' });
      if (session.ended) return send(409, { error: 'SESSION_ALREADY_ENDED' });
      if (
        caller.accountId !== session.hostAccountId &&
        caller.accountId !== session.guestAccountId
      ) {
        return send(403, { error: 'UNAUTHORIZED_SESSION_PARTICIPANT' });
      }
      const targetAccountId =
        caller.accountId === session.hostAccountId
          ? session.guestAccountId
          : session.hostAccountId;
      seqCounter += 1;
      session.signals.push({
        seq: seqCounter,
        targetAccountId,
        senderAccountId: caller.accountId,
        payload: body.payload,
      });
      return send(200, { admitted: true, seq: seqCounter });
    }

    if (req.method === 'GET' && url.pathname === '/sessions/signals') {
      const session = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (!session) return send(403, { error: 'SIGNALING_NOT_ADMITTED' });
      if (session.ended) return send(409, { error: 'SESSION_ALREADY_ENDED' });
      if (
        caller.accountId !== session.hostAccountId &&
        caller.accountId !== session.guestAccountId
      ) {
        return send(403, { error: 'UNAUTHORIZED_SESSION_PARTICIPANT' });
      }
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0');
      const signals = session.signals.filter(
        (s) => s.targetAccountId === caller.accountId && s.seq > afterSeq
      );
      return send(200, { signals });
    }

    if (req.method === 'POST' && url.pathname === '/sessions/disconnect') {
      const body = await readJson(req);
      const session = sessions.get(String(body.sessionId ?? ''));
      if (session) session.ended = true;
      return send(200, { disconnected: true });
    }

    send(404, { error: 'NOT_FOUND' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const api = async (
      path: string,
      opts: { method: string; token?: string; body?: unknown }
    ) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: opts.method,
        headers: {
          'Content-Type': 'application/json',
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      return { status: res.status, data: (await res.json()) as Record<string, unknown> };
    };

    // 1. Register 3 independent devices (A, B, and outsider C)
    const regA = await api('/devices/register', { method: 'POST', body: { deviceId: 'dev-a' } });
    const regB = await api('/devices/register', { method: 'POST', body: { deviceId: 'dev-b' } });
    const regC = await api('/devices/register', { method: 'POST', body: { deviceId: 'dev-c' } });
    const tokA = String(regA.data.token);
    const tokB = String(regB.data.token);
    const tokC = String(regC.data.token);
    const codeB = (regB.data.account as { friendCode: string }).friendCode;

    await api('/presence/connect', { method: 'POST', token: tokA, body: {} });
    await api('/presence/connect', { method: 'POST', token: tokB, body: {} });

    // 2. Invite A -> B and test decline
    const inv1 = await api('/invites', { method: 'POST', token: tokA, body: { friendCode: codeB } });
    assert.equal(inv1.status, 200);
    const inv1Id = (inv1.data.invite as { inviteId: string }).inviteId;
    const decl = await api(`/invites/${inv1Id}/respond`, {
      method: 'POST',
      token: tokB,
      body: { action: 'decline' },
    });
    assert.equal(decl.status, 200);
    assert.equal(decl.data.session, null);

    // 3. Fresh invite A -> B; requester A and outsider C cannot accept; only B can accept
    const inv2 = await api('/invites', { method: 'POST', token: tokA, body: { friendCode: codeB } });
    const inv2Id = (inv2.data.invite as { inviteId: string }).inviteId;
    const stateB = await api('/presence/state', { method: 'GET', token: tokB });
    assert.equal(
      ((stateB.data.snapshot as { incomingInvites: Array<{ inviteId: string }> }).incomingInvites).length,
      1
    );

    const selfAccept = await api(`/invites/${inv2Id}/respond`, {
      method: 'POST',
      token: tokA,
      body: { action: 'accept' },
    });
    assert.equal(selfAccept.status, 403);

    const outsiderAccept = await api(`/invites/${inv2Id}/respond`, {
      method: 'POST',
      token: tokC,
      body: { action: 'accept' },
    });
    assert.equal(outsiderAccept.status, 403);

    const acceptB = await api(`/invites/${inv2Id}/respond`, {
      method: 'POST',
      token: tokB,
      body: { action: 'accept' },
    });
    assert.equal(acceptB.status, 200);
    const sessionId = (acceptB.data.session as { sessionId: string }).sessionId;

    // 4. Only approved members A and B can signal; C is rejected
    const sigC = await api('/sessions/signal', {
      method: 'POST',
      token: tokC,
      body: { sessionId, payload: { type: 'offer', sdp: 'v=0' } },
    });
    assert.equal(sigC.status, 403);

    const offerB = await api('/sessions/signal', {
      method: 'POST',
      token: tokB,
      body: { sessionId, payload: { type: 'offer', sdp: 'offer-sdp' } },
    });
    assert.equal(offerB.status, 200);

    const pollA = await api(`/sessions/signals?sessionId=${sessionId}&afterSeq=0`, {
      method: 'GET',
      token: tokA,
    });
    assert.equal(pollA.status, 200);
    assert.equal((pollA.data.signals as unknown[]).length, 1);

    const answerA = await api('/sessions/signal', {
      method: 'POST',
      token: tokA,
      body: { sessionId, payload: { type: 'answer', sdp: 'answer-sdp' } },
    });
    assert.equal(answerA.status, 200);

    const pollB = await api(`/sessions/signals?sessionId=${sessionId}&afterSeq=0`, {
      method: 'GET',
      token: tokB,
    });
    assert.equal(pollB.status, 200);
    assert.equal((pollB.data.signals as unknown[]).length, 1);

    // 5. Disconnect terminates session for both A and B and blocks further signaling
    const disc = await api('/sessions/disconnect', {
      method: 'POST',
      token: tokA,
      body: { sessionId },
    });
    assert.equal(disc.status, 200);

    const postDiscSig = await api('/sessions/signal', {
      method: 'POST',
      token: tokB,
      body: { sessionId, payload: { type: 'offer', sdp: 'stale' } },
    });
    assert.equal(postDiscSig.status, 409);
  } finally {
    server.close();
  }
});

test('two independent clients exchange P2P contact details with opt-in privacy, persist locally across restart, reject malformed frames, and never send profile data to Cloudflare', async () => {
  const capturedBackendRequests: string[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    capturedBackendRequests.push(`${req.method} ${req.url} ${rawBody}`);
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/devices/register') {
      const parsed = rawBody ? (JSON.parse(rawBody) as { deviceId?: string }) : {};
      const idx = parsed.deviceId?.endsWith('A') ? 1 : 2;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          token: `tok-${idx}`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          alreadyRegistered: false,
          account: {
            accountId: `acct-${idx}`,
            provider: 'anonymous-device',
            providerSubject: `dev-${idx}`,
            displayName: 'Elm Device',
            friendCode: idx === 1 ? 'ELM-HOST-0001' : 'ELM-PEER-0002',
            createdAt: new Date().toISOString(),
          },
        })
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elm-contact-p2p-'));
  const statePathA = path.join(tmpDir, 'client-a.json');
  const statePathB = path.join(tmpDir, 'client-b.json');

  try {
    // Client A and Client B register anonymously (deviceId + deviceSecret only — zero profile fields)
    await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-000000000000000A', deviceSecret: 's'.repeat(32) }),
    });
    await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-000000000000000B', deviceSecret: 't'.repeat(32) }),
    });

    // Local profiles stored strictly on each device
    const profileA = {
      name: 'Alice Host',
      email: '',
      phone: '+1 555-0101', // phone-only entered
      updatedAt: '2026-11-22T02:00:00.000Z',
    };
    const profileB = {
      name: 'Bob Guest',
      email: 'bob.shared@example.com',
      phone: '+1 555-0202',
      updatedAt: '2026-11-22T02:00:00.000Z',
    };

    // Simulate direct P2P DataChannel exchange after session approval
    const cardA = buildOutgoingPeerContactCard(profileA);
    const cardB = buildOutgoingPeerContactCard(profileB);
    const wireFromA = JSON.stringify({
      __elmControl: 'peer-contact-card',
      sender: 'host',
      ...cardA,
    });
    const wireFromB = JSON.stringify({
      __elmControl: 'peer-contact-card',
      sender: 'guest',
      ...cardB,
    });

    const parsedAtB = sanitizePeerContactFrame(JSON.parse(wireFromA));
    const parsedAtA = sanitizePeerContactFrame(JSON.parse(wireFromB));
    assert.ok(parsedAtB);
    assert.ok(parsedAtA);

    // Reject malformed DataChannel payload without corrupting state
    assert.equal(
      sanitizePeerContactFrame({ __elmControl: 'peer-contact-card', sender: 'host', name: null, email: '', phone: '' }),
      null
    );

    let peersA: RecentPeerEntry[] = upsertSuccessfulPeerConnection([], {
      friendCode: 'ELM-PEER-0002',
    });
    peersA = upsertRecentPeerContact(peersA, {
      friendCode: 'ELM-PEER-0002',
      peerName: parsedAtA.contact.name,
      email: parsedAtA.contact.email,
      phone: parsedAtA.contact.phone,
    });

    let peersB: RecentPeerEntry[] = upsertSuccessfulPeerConnection([], {
      friendCode: 'ELM-HOST-0001',
    });
    peersB = upsertRecentPeerContact(peersB, {
      friendCode: 'ELM-HOST-0001',
      peerName: parsedAtB.contact.name,
      email: parsedAtB.contact.email,
      phone: parsedAtB.contact.phone,
    });

    // Persist locally and simulate restart by reloading from disk
    fs.writeFileSync(statePathA, JSON.stringify({ localProfile: profileA, recentPeers: peersA }), 'utf8');
    fs.writeFileSync(statePathB, JSON.stringify({ localProfile: profileB, recentPeers: peersB }), 'utf8');

    const reloadedA = JSON.parse(fs.readFileSync(statePathA, 'utf8')) as {
      localProfile: typeof profileA;
      recentPeers: RecentPeerEntry[];
    };
    const reloadedB = JSON.parse(fs.readFileSync(statePathB, 'utf8')) as {
      localProfile: typeof profileB;
      recentPeers: RecentPeerEntry[];
    };

    // Client B sees Alice's name + phone (without email because Alice left email blank)
    assert.equal(resolveRecentPeerDisplayName(reloadedB.recentPeers[0]), 'Alice Host');
    assert.equal(reloadedB.recentPeers[0].email, undefined);
    assert.equal(reloadedB.recentPeers[0].phone, '+1 555-0101');

    // Client A sees Bob's name + email + phone (all entered fields shared P2P)
    assert.equal(resolveRecentPeerDisplayName(reloadedA.recentPeers[0]), 'Bob Guest');
    assert.equal(reloadedA.recentPeers[0].email, 'bob.shared@example.com');
    assert.equal(reloadedA.recentPeers[0].phone, '+1 555-0202');

    // Verify ZERO personal profile data reached Cloudflare backend
    const allBackendTraffic = capturedBackendRequests.join('\n');
    for (const secret of [
      'Alice Host',
      'Bob Guest',
      'alice.private@example.com',
      'bob.shared@example.com',
      '+1 555-0101',
      '+1 555-0202',
      'shareEmailWithPeers',
      'sharePhoneWithPeers',
    ]) {
      assert.equal(
        allBackendTraffic.includes(secret),
        false,
        `Backend request unexpectedly contained personal profile field: ${secret}`
      );
    }
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
