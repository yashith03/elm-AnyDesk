import assert from 'node:assert/strict';
import test from 'node:test';
import { formatIncomingRequestHeadline } from '../src/shared/incoming-request.ts';
import {
  buildOutgoingPeerContactCard,
  removeRecentPeerEntry,
  renameRecentPeerEntry,
  resolveRecentPeerDisplayName,
  sanitizePeerContactFrame,
  sortRecentPeers,
  toggleFavoritePeerEntry,
  upsertRecentPeerContact,
  upsertSuccessfulPeerConnection,
  type RecentPeerEntry,
} from '../src/shared/recent-peers.ts';

test('sortRecentPeers keeps favorites before non-favorites and sorts each group by recency', () => {
  const peers: RecentPeerEntry[] = [
    {
      friendCode: 'ELM-1111-1111',
      alias: 'Recent Newer',
      favorite: false,
      lastConnectedAt: '2026-11-17T10:00:00.000Z',
    },
    {
      friendCode: 'ELM-2222-2222',
      alias: 'Fav Older',
      favorite: true,
      lastConnectedAt: '2026-11-16T08:00:00.000Z',
    },
    {
      friendCode: 'ELM-3333-3333',
      alias: 'Fav Newer',
      favorite: true,
      lastConnectedAt: '2026-11-17T09:00:00.000Z',
    },
    {
      friendCode: 'ELM-4444-4444',
      alias: 'Recent Older',
      favorite: false,
      lastConnectedAt: '2026-11-15T10:00:00.000Z',
    },
  ];

  const sorted = sortRecentPeers(peers);
  assert.deepEqual(
    sorted.map((p) => p.friendCode),
    ['ELM-3333-3333', 'ELM-2222-2222', 'ELM-1111-1111', 'ELM-4444-4444']
  );
});

test('upsertSuccessfulPeerConnection merges existing peer without dropping alias/favorite', () => {
  const initial = upsertSuccessfulPeerConnection([], {
    friendCode: 'elm-abcd-efgh',
    defaultAlias: 'Studio PC',
    connectedAt: '2026-11-17T08:00:00.000Z',
  });
  assert.equal(initial.length, 1);
  assert.equal(initial[0].friendCode, 'ELM-ABCD-EFGH');
  assert.equal(initial[0].alias, 'Studio PC');

  const starred = toggleFavoritePeerEntry(initial, 'ELM-ABCD-EFGH');
  assert.equal(starred[0].favorite, true);

  const renamed = renameRecentPeerEntry(starred, 'ELM-ABCD-EFGH', 'Workstation');
  assert.equal(renamed[0].alias, 'Workstation');

  // Re-connecting updates timestamp and keeps alias + favorite
  const updated = upsertSuccessfulPeerConnection(renamed, {
    friendCode: 'ELM-ABCD-EFGH',
    defaultAlias: 'Elm Device',
    connectedAt: '2026-11-17T09:30:00.000Z',
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].alias, 'Workstation');
  assert.equal(updated[0].favorite, true);
  assert.equal(updated[0].lastConnectedAt, '2026-11-17T09:30:00.000Z');

  const removed = removeRecentPeerEntry(updated, 'ELM-ABCD-EFGH');
  assert.equal(removed.length, 0);
});

test('formatIncomingRequestHeadline distinguishes connect vs reverse invite intents', () => {
  assert.equal(
    formatIncomingRequestHeadline({
      requesterDisplayName: 'Sam',
      requesterFriendCode: 'ELM-1234-5678',
      intent: 'connect',
    }),
    'Sam wants to connect'
  );
  assert.equal(
    formatIncomingRequestHeadline({
      requesterDisplayName: 'Sam',
      requesterFriendCode: 'ELM-1234-5678',
      intent: 'invite',
    }),
    'Sam invited you to view their screen'
  );
  assert.equal(
    formatIncomingRequestHeadline({
      requesterDisplayName: 'Elm Device',
      requesterFriendCode: 'ELM-1234-5678',
      intent: 'invite',
    }),
    'Device ELM-1234-5678 invited you to view their screen'
  );
});

test('resolveRecentPeerDisplayName follows priority: custom alias > received peerName > Device Code', () => {
  assert.equal(
    resolveRecentPeerDisplayName({
      friendCode: 'ELM-1111-2222',
      alias: 'My Custom Name',
      peerName: 'Friend Real Name',
    }),
    'My Custom Name'
  );
  assert.equal(
    resolveRecentPeerDisplayName({
      friendCode: 'ELM-1111-2222',
      alias: '',
      peerName: 'Friend Real Name',
    }),
    'Friend Real Name'
  );
  assert.equal(
    resolveRecentPeerDisplayName({
      friendCode: 'ELM-1111-2222',
      alias: '',
      peerName: 'Elm Device',
    }),
    'ELM-1111-2222'
  );
  assert.equal(
    resolveRecentPeerDisplayName({
      friendCode: 'ELM-1111-2222',
      alias: '   ',
    }),
    'ELM-1111-2222'
  );
});

test('buildOutgoingPeerContactCard always shares entered name, email, and phone P2P after approval', () => {
  assert.deepEqual(
    buildOutgoingPeerContactCard({
      name: 'Nimal Perera',
      email: 'nimal@example.com',
      phone: '+94 77 123 4567',
      updatedAt: '2026-11-22T00:00:00.000Z',
    }),
    {
      name: 'Nimal Perera',
      email: 'nimal@example.com',
      phone: '+94 77 123 4567',
    }
  );

  // Phone entered without email -> phone shared independently
  assert.deepEqual(
    buildOutgoingPeerContactCard({
      name: 'Nimal Perera',
      email: '',
      phone: '+94 77 123 4567',
      updatedAt: '2026-11-22T00:00:00.000Z',
    }),
    {
      name: 'Nimal Perera',
      email: '',
      phone: '+94 77 123 4567',
    }
  );

  // Blank email & phone -> only name shared
  assert.deepEqual(
    buildOutgoingPeerContactCard({
      name: 'Nimal Perera',
      email: '',
      phone: '',
      updatedAt: '2026-11-22T00:00:00.000Z',
    }),
    {
      name: 'Nimal Perera',
      email: '',
      phone: '',
    }
  );
});

test('sanitizePeerContactFrame rejects malformed/oversized frames and sanitizes valid contact payloads', () => {
  assert.equal(sanitizePeerContactFrame(null), null);
  assert.equal(sanitizePeerContactFrame('not-an-object'), null);
  assert.equal(sanitizePeerContactFrame([]), null);
  assert.equal(
    sanitizePeerContactFrame({
      __elmControl: 'other',
      sender: 'host',
      name: 'Alice',
      email: '',
      phone: '',
    }),
    null
  );
  assert.equal(
    sanitizePeerContactFrame({
      __elmControl: 'peer-contact-card',
      sender: 'invalid-role',
      name: 'Alice',
      email: '',
      phone: '',
    }),
    null
  );
  assert.equal(
    sanitizePeerContactFrame({
      __elmControl: 'peer-contact-card',
      sender: 'host',
      name: 123,
      email: '',
      phone: '',
    }),
    null
  );
  assert.equal(
    sanitizePeerContactFrame({
      __elmControl: 'peer-contact-card',
      sender: 'guest',
      name: 'A'.repeat(600),
      email: '',
      phone: '',
    }),
    null
  );

  const sanitized = sanitizePeerContactFrame({
    __elmControl: 'peer-contact-card',
    sender: 'host',
    name: '  Alice\u0000  Smith  ',
    email: 'not-an-email',
    phone: '+1 (555) 010-2000',
  });
  assert.deepEqual(sanitized, {
    sender: 'host',
    contact: {
      name: 'Alice Smith',
      email: '',
      phone: '+1 (555) 010-2000',
    },
  });
});

test('upsertRecentPeerContact preserves custom alias and favorite while syncing peerName, email, and phone', () => {
  let peers = upsertSuccessfulPeerConnection([], {
    friendCode: 'ELM-ABCD-1234',
    connectedAt: '2026-11-22T01:00:00.000Z',
  });
  peers = toggleFavoritePeerEntry(peers, 'ELM-ABCD-1234');
  peers = upsertRecentPeerContact(peers, {
    friendCode: 'ELM-ABCD-1234',
    peerName: 'Alice',
    email: 'alice@example.com',
    phone: '+1 555-0100',
  });
  assert.equal(peers[0].favorite, true);
  assert.equal(peers[0].alias, '');
  assert.equal(peers[0].peerName, 'Alice');
  assert.equal(peers[0].email, 'alice@example.com');
  assert.equal(peers[0].phone, '+1 555-0100');
  assert.equal(resolveRecentPeerDisplayName(peers[0]), 'Alice');

  peers = renameRecentPeerEntry(peers, 'ELM-ABCD-1234', 'Office Host');
  peers = upsertRecentPeerContact(peers, {
    friendCode: 'ELM-ABCD-1234',
    peerName: 'Alice Updated',
    email: '',
    phone: '+1 555-0199',
  });
  assert.equal(peers[0].alias, 'Office Host');
  assert.equal(peers[0].favorite, true);
  assert.equal(peers[0].peerName, 'Alice Updated');
  assert.equal(peers[0].email, undefined);
  assert.equal(peers[0].phone, '+1 555-0199');
  assert.equal(resolveRecentPeerDisplayName(peers[0]), 'Office Host');
});
