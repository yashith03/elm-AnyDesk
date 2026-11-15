import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_IMAGE_CHUNK_CHARS,
  ChatImageReassemblyBuffer,
  MAX_CHAT_IMAGE_BYTES,
  SUPPORTED_CHAT_IMAGE_MIME_TYPES,
  chunkChatImagePayload,
  validateChatImageAttachment,
} from '../src/shared/chat-attachments.ts';

test('validateChatImageAttachment accepts supported MIME types within 2 MiB limit', () => {
  for (const mimeType of SUPPORTED_CHAT_IMAGE_MIME_TYPES) {
    const res = validateChatImageAttachment({
      mimeType,
      byteLength: 1024,
      dataUrl: `data:${mimeType};base64,AAAA`,
    });
    assert.equal(res.ok, true, `expected ${mimeType} to be accepted`);
  }
});

test('validateChatImageAttachment rejects unsupported MIME types and oversized images with clear errors', () => {
  const badMime = validateChatImageAttachment({
    mimeType: 'image/svg+xml',
    byteLength: 512,
    dataUrl: 'data:image/svg+xml;base64,AAAA',
  });
  assert.equal(badMime.ok, false);
  assert.match(badMime.error, /Unsupported image type/i);

  const empty = validateChatImageAttachment({
    mimeType: 'image/png',
    byteLength: 0,
    dataUrl: 'data:image/png;base64,',
  });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/i);

  const oversized = validateChatImageAttachment({
    mimeType: 'image/png',
    byteLength: MAX_CHAT_IMAGE_BYTES + 1,
    dataUrl: 'data:image/png;base64,AAAA',
  });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /2 MB/i);
});

test('chunkChatImagePayload and ChatImageReassemblyBuffer reassemble multi-chunk P2P image and reject mismatched sessions', () => {
  const payloadBody = 'A'.repeat(CHAT_IMAGE_CHUNK_CHARS * 2 + 123);
  const dataUrl = `data:image/png;base64,${payloadBody}`;
  const frames = chunkChatImagePayload({
    messageId: 'msg-1',
    sessionId: 'sess-1',
    senderAccountId: 'acct-a',
    senderDisplayName: 'Alice',
    sentAt: '2026-11-15T00:00:00.000Z',
    text: 'Look at this',
    mimeType: 'image/png',
    dataUrl,
  });

  assert.equal(frames.length, 3);
  const buffer = new ChatImageReassemblyBuffer();

  // Wrong session ID is ignored
  assert.equal(buffer.acceptChunk(frames[0], 'sess-other'), null);
  assert.equal(buffer.pendingCount, 0);

  // Out-of-order reassembly completes on final chunk
  assert.equal(buffer.acceptChunk(frames[2], 'sess-1'), null);
  assert.equal(buffer.pendingCount, 1);
  assert.equal(buffer.acceptChunk(frames[0], 'sess-1'), null);
  const completed = buffer.acceptChunk(frames[1], 'sess-1');

  assert.ok(completed);
  assert.equal(buffer.pendingCount, 0);
  assert.equal(completed.dataUrl, dataUrl);
  assert.equal(completed.message.text, 'Look at this');
  assert.equal(completed.message.senderAccountId, 'acct-a');
});

test('ChatImageReassemblyBuffer.clear discards partial buffers on session end', () => {
  const dataUrl = `data:image/jpeg;base64,${'B'.repeat(CHAT_IMAGE_CHUNK_CHARS + 50)}`;
  const frames = chunkChatImagePayload({
    messageId: 'msg-2',
    sessionId: 'sess-2',
    senderAccountId: 'acct-b',
    senderDisplayName: 'Bob',
    sentAt: '2026-11-15T00:00:00.000Z',
    text: '',
    mimeType: 'image/jpeg',
    dataUrl,
  });

  const buffer = new ChatImageReassemblyBuffer();
  assert.equal(buffer.acceptChunk(frames[0], 'sess-2'), null);
  assert.equal(buffer.pendingCount, 1);
  buffer.clear();
  assert.equal(buffer.pendingCount, 0);
});
