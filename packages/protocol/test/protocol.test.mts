import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_HOST_MEDIA_SELECTION,
  DEFAULT_LIVENESS_CONFIG,
  generateRandomFriendCode,
  isValidFriendCode,
  normalizeFriendCode,
  PILOT_NETWORK_POLICY,
  PROTOCOL_VERSION,
  sanitizeHostMediaSelection,
  STUN_ICE_SERVERS,
  validateStunOnlyIceServers,
} from '../src/index.ts';

test('Protocol version, Friend Code generation/validation, and audio-off defaults', () => {
  assert.equal(PROTOCOL_VERSION, '0.5.0-phase5');
  assert.equal(DEFAULT_HOST_MEDIA_SELECTION.screenVideo, false);
  assert.equal(DEFAULT_HOST_MEDIA_SELECTION.microphoneAudio, false);
  assert.equal(DEFAULT_HOST_MEDIA_SELECTION.deviceAudio, false);

  const sanitized = sanitizeHostMediaSelection({ screenVideo: true });
  assert.deepEqual(sanitized, {
    screenVideo: true,
    microphoneAudio: false,
    deviceAudio: false,
  });

  const code = generateRandomFriendCode();
  assert.equal(isValidFriendCode(code), true);
  assert.equal(isValidFriendCode(code.toLowerCase()), true);
  assert.equal(normalizeFriendCode(`  ${code.toLowerCase()} `), code);
  assert.equal(isValidFriendCode('ELM-0000-1111'), false);
});

test('STUN-only zero-bill pilot policy rejects TURN relays and disables auto-upgrades', () => {
  assert.equal(PILOT_NETWORK_POLICY.stunOnly, true);
  assert.equal(PILOT_NETWORK_POLICY.turnEnabled, false);
  assert.equal(PILOT_NETWORK_POLICY.paidServicesEnabled, false);
  assert.equal(PILOT_NETWORK_POLICY.autoUpgradeEnabled, false);
  assert.ok(DEFAULT_LIVENESS_CONFIG.livenessTimeoutMs > DEFAULT_LIVENESS_CONFIG.heartbeatIntervalMs);

  const validStunCheck = validateStunOnlyIceServers(STUN_ICE_SERVERS);
  assert.equal(validStunCheck.valid, true);
  assert.equal(validStunCheck.rejectedUrls.length, 0);

  const rejectedTurnCheck = validateStunOnlyIceServers([
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:turn.example.com:3478?transport=udp' },
    { urls: 'turns:turn.example.com:5349' },
  ]);
  assert.equal(rejectedTurnCheck.valid, false);
  assert.deepEqual(rejectedTurnCheck.rejectedUrls, [
    'turn:turn.example.com:3478?transport=udp',
    'turns:turn.example.com:5349',
  ]);
});
