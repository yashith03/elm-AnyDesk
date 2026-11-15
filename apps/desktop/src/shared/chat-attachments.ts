import type { EphemeralChatMessage } from '@elm/protocol';

export const SUPPORTED_CHAT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export const MAX_CHAT_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const CHAT_IMAGE_CHUNK_CHARS = 16 * 1024;
export const MAX_CHAT_IMAGE_CHUNKS = 200;

export interface ChatImageChunkFrame {
  readonly __elmImageChunk: true;
  readonly messageId: string;
  readonly sessionId: string;
  readonly senderAccountId: string;
  readonly senderDisplayName: string;
  readonly sentAt: string;
  readonly text: string;
  readonly mimeType: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly dataSlice: string;
}

export function validateChatImageAttachment(params: {
  mimeType: string;
  byteLength: number;
  dataUrl: string;
}): { ok: true } | { ok: false; error: string } {
  const normalizedMime = params.mimeType.trim().toLowerCase();
  if (
    !(SUPPORTED_CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(
      normalizedMime
    )
  ) {
    return {
      ok: false,
      error: `Unsupported image type "${params.mimeType || 'unknown'}". Supported types: PNG, JPEG, WEBP, GIF.`,
    };
  }
  if (!Number.isFinite(params.byteLength) || params.byteLength <= 0) {
    return {
      ok: false,
      error: 'Image attachment is empty.',
    };
  }
  if (params.byteLength > MAX_CHAT_IMAGE_BYTES) {
    return {
      ok: false,
      error: `Image exceeds the ${Math.round(
        MAX_CHAT_IMAGE_BYTES / (1024 * 1024)
      )} MB peer-to-peer transfer limit.`,
    };
  }
  if (!params.dataUrl.startsWith(`data:${normalizedMime};base64,`)) {
    return {
      ok: false,
      error: 'Invalid base64 image data URL.',
    };
  }
  return { ok: true };
}

export function chunkChatImagePayload(params: {
  messageId: string;
  sessionId: string;
  senderAccountId: string;
  senderDisplayName: string;
  sentAt: string;
  text: string;
  mimeType: string;
  dataUrl: string;
}): ChatImageChunkFrame[] {
  const totalChunks = Math.max(
    1,
    Math.ceil(params.dataUrl.length / CHAT_IMAGE_CHUNK_CHARS)
  );
  if (totalChunks > MAX_CHAT_IMAGE_CHUNKS) {
    throw new Error('Image payload exceeds maximum allowed transfer chunks.');
  }
  const frames: ChatImageChunkFrame[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHAT_IMAGE_CHUNK_CHARS;
    frames.push({
      __elmImageChunk: true,
      messageId: params.messageId,
      sessionId: params.sessionId,
      senderAccountId: params.senderAccountId,
      senderDisplayName: params.senderDisplayName,
      sentAt: params.sentAt,
      text: i === 0 ? params.text : '',
      mimeType: params.mimeType,
      chunkIndex: i,
      totalChunks,
      dataSlice: params.dataUrl.slice(start, start + CHAT_IMAGE_CHUNK_CHARS),
    });
  }
  return frames;
}

export class ChatImageReassemblyBuffer {
  private readonly pending = new Map<
    string,
    {
      totalChunks: number;
      slices: Array<string | undefined>;
      receivedCount: number;
      meta: EphemeralChatMessage;
      mimeType: string;
    }
  >();

  public acceptChunk(
    frame: ChatImageChunkFrame,
    expectedSessionId: string
  ): { message: EphemeralChatMessage; dataUrl: string } | null {
    if (
      !frame ||
      frame.sessionId !== expectedSessionId ||
      frame.totalChunks <= 0 ||
      frame.totalChunks > MAX_CHAT_IMAGE_CHUNKS ||
      frame.chunkIndex < 0 ||
      frame.chunkIndex >= frame.totalChunks
    ) {
      return null;
    }

    let entry = this.pending.get(frame.messageId);
    if (!entry) {
      entry = {
        totalChunks: frame.totalChunks,
        slices: new Array<string | undefined>(frame.totalChunks),
        receivedCount: 0,
        meta: {
          messageId: frame.messageId,
          sessionId: frame.sessionId,
          senderAccountId: frame.senderAccountId,
          senderDisplayName: frame.senderDisplayName,
          text: frame.text || '[Image]',
          sentAt: frame.sentAt,
        },
        mimeType: frame.mimeType,
      };
      this.pending.set(frame.messageId, entry);
    }

    if (entry.slices[frame.chunkIndex] === undefined) {
      entry.slices[frame.chunkIndex] = frame.dataSlice;
      entry.receivedCount += 1;
    }
    if (frame.chunkIndex === 0 && frame.text) {
      entry.meta = { ...entry.meta, text: frame.text };
    }

    if (entry.receivedCount < entry.totalChunks) {
      return null;
    }

    this.pending.delete(frame.messageId);
    const dataUrl = entry.slices.join('');
    if (!dataUrl.startsWith(`data:${entry.mimeType.toLowerCase()};base64,`)) {
      return null;
    }
    return {
      message: entry.meta,
      dataUrl,
    };
  }

  public get pendingCount(): number {
    return this.pending.size;
  }

  public clear(): void {
    this.pending.clear();
  }
}
