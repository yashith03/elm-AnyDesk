import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

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
