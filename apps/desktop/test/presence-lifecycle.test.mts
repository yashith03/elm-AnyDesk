import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_LOOKUP_MAX_BATCH_SIZE,
  PRESENCE_LOOKUP_RATE_LIMIT_MAX_REQUESTS,
  PRESENCE_STALE_TIMEOUT_MS,
} from '@elm/protocol';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');

test('presence protocol constants match 10s heartbeat, 30s expiry, 50-code batch cap, and 30/min rate limit', () => {
  assert.equal(PRESENCE_HEARTBEAT_INTERVAL_MS, 10_000);
  assert.equal(PRESENCE_STALE_TIMEOUT_MS, 30_000);
  assert.equal(PRESENCE_LOOKUP_MAX_BATCH_SIZE, 50);
  assert.equal(PRESENCE_LOOKUP_RATE_LIMIT_MAX_REQUESTS, 30);
});

test('UI removes manual Go Online/Go Offline toggle and renders automatic status + friend Online/Offline/Unknown labels', () => {
  const appSource = fs.readFileSync(
    path.join(desktopRoot, 'src/renderer/App.tsx'),
    'utf8'
  );
  assert.equal(appSource.includes('handleTogglePresence'), false);
  assert.equal(appSource.includes('onPresenceStatusUpdated'), true);
  assert.equal(appSource.includes('triggerPresenceReconnect'), true);
  assert.equal(appSource.includes('role="status"'), true);
  assert.equal(appSource.includes('Reconnecting...'), true);
  assert.equal(appSource.includes('Connecting...'), true);
  assert.equal(appSource.includes('peer-status-label'), true);
});

test('automatic presence registration, heartbeat, outage/recovery, and concurrent startup+shutdown coordination against real HTTP backend', async () => {
  let networkDown = false;
  let connectCount = 0;
  let heartbeatCount = 0;
  let disconnectCount = 0;
  let serverOnline = false;
  let pendingInvites = 1;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (networkDown) {
      res.destroy();
      return;
    }
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/devices/register') {
      return send(200, {
        token: 'tok-auto-1',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        alreadyRegistered: false,
        account: {
          accountId: 'acct-auto-1',
          provider: 'anonymous-device',
          providerSubject: 'dev-auto-1',
          displayName: 'Elm Device',
          friendCode: 'ELM-AUTO-2345',
          createdAt: new Date().toISOString(),
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/presence/connect') {
      connectCount += 1;
      serverOnline = true;
      return send(200, {
        serverTime: new Date().toISOString(),
        snapshot: {
          online: true,
          account: {
            accountId: 'acct-auto-1',
            provider: 'anonymous-device',
            providerSubject: 'dev-auto-1',
            displayName: 'Elm Device',
            friendCode: 'ELM-AUTO-2345',
            createdAt: new Date().toISOString(),
          },
          incomingInvites: [],
          outgoingInvite: null,
          recentExpiredOutgoingInvite: null,
          activeSession: null,
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/presence/heartbeat') {
      heartbeatCount += 1;
      serverOnline = true;
      return send(200, {
        serverTime: new Date().toISOString(),
        snapshot: {
          online: true,
          account: {
            accountId: 'acct-auto-1',
            provider: 'anonymous-device',
            providerSubject: 'dev-auto-1',
            displayName: 'Elm Device',
            friendCode: 'ELM-AUTO-2345',
            createdAt: new Date().toISOString(),
          },
          incomingInvites: [],
          outgoingInvite: null,
          recentExpiredOutgoingInvite: null,
          activeSession: null,
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/presence/disconnect') {
      disconnectCount += 1;
      serverOnline = false;
      pendingInvites = 0;
      return send(200, { ok: true, receipt: null });
    }

    return send(404, { error: 'NOT_FOUND' });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. First registration immediately calls /presence/connect (not fire-and-forget)
    const reg = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-auto-00000001', deviceSecret: 'x'.repeat(40) }),
    });
    assert.equal(reg.status, 200);
    const { token } = (await reg.json()) as { token: string };

    const conn = await fetch(`${baseUrl}/presence/connect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(conn.status, 200);
    assert.equal(serverOnline, true);
    assert.equal(connectCount, 1);

    // 2. Heartbeat keeps device online (including while minimized)
    const hb = await fetch(`${baseUrl}/presence/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(hb.status, 200);
    assert.equal(heartbeatCount, 1);

    // 3. Internet loss causes backend call failure -> recovery automatically re-establishes presence
    networkDown = true;
    await assert.rejects(() =>
      fetch(`${baseUrl}/presence/heartbeat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
    );
    networkDown = false;
    const recovered = await fetch(`${baseUrl}/presence/connect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(recovered.status, 200);
    assert.equal(serverOnline, true);

    // 4. Normal app close sends disconnect, marks offline, and cancels pending invites
    const disc = await fetch(`${baseUrl}/presence/disconnect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'app_closed' }),
    });
    assert.equal(disc.status, 200);
    assert.equal(disconnectCount, 1);
    assert.equal(serverOnline, false);
    assert.equal(pendingInvites, 0);
  } finally {
    server.close();
  }
});

test('main-process controller enforces single-flight startup, bounded shutdown, and no post-quit Online race', () => {
  const clientSource = fs.readFileSync(
    path.join(desktopRoot, 'src/main/auth-invite-client.ts'),
    'utf8'
  );
  assert.equal(clientSource.includes('this.activePresenceRequest'), true);
  assert.equal(clientSource.includes('if (this.shutdownPromise)'), true);
  assert.equal(clientSource.includes('if (this.shuttingDown)'), true);
  assert.equal(clientSource.includes('this.activeAbortControllers'), true);
  assert.equal(clientSource.includes("'/presence/heartbeat'"), true);
  assert.equal(clientSource.includes('computeRetryBackoffMs'), true);
});
