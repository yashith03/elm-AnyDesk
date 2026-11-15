import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_HOST_MEDIA_SELECTION } from '@elm/protocol';
import { formatIncomingRequestHeadline } from '../src/shared/incoming-request.ts';

test('formatIncomingRequestHeadline shows "<Display name> wants to connect" when direct local name exists', () => {
  const headline = formatIncomingRequestHeadline({
    requesterDisplayName: 'Alex Rivera',
    requesterFriendCode: 'ELM-2345-6789',
  });
  assert.equal(headline, 'Alex Rivera wants to connect');
});

test('formatIncomingRequestHeadline falls back to "Device <code> wants to connect" for generic or missing names', () => {
  assert.equal(
    formatIncomingRequestHeadline({
      requesterDisplayName: 'Elm Device',
      requesterFriendCode: 'ELM-2345-6789',
    }),
    'Device ELM-2345-6789 wants to connect'
  );
  assert.equal(
    formatIncomingRequestHeadline({
      requesterDisplayName: '',
      requesterFriendCode: 'ELM-9876-5432',
    }),
    'Device ELM-9876-5432 wants to connect'
  );
  assert.equal(
    formatIncomingRequestHeadline({
      requesterDisplayName: 'alex@example.com',
      requesterFriendCode: 'ELM-9876-5432',
    }),
    'Device ELM-9876-5432 wants to connect'
  );
});

test('Incoming request audio options default OFF', () => {
  assert.equal(DEFAULT_HOST_MEDIA_SELECTION.microphoneAudio, false);
  assert.equal(DEFAULT_HOST_MEDIA_SELECTION.deviceAudio, false);
});
