import {
  DEFAULT_LIVENESS_CONFIG,
  INVITE_TIMEOUT_MS,
  PRESENCE_LOOKUP_RATE_LIMIT_MAX_REQUESTS,
  PRESENCE_LOOKUP_RATE_LIMIT_WINDOW_MS,
  PRESENCE_STALE_TIMEOUT_MS,
  sanitizeHostMediaSelection,
  type AccountProfile,
  type ApprovedSessionSummary,
  type CoordinatorServerEvent,
  type HostMediaSelection,
  type InviteIntent,
  type InviteStatus,
  type InviteSummary,
  type PresenceStateSnapshot,
  type ProtocolErrorCode,
  type SessionTeardownReceipt,
  type SessionTerminationReason,
  type WebRtcSignalEnvelope,
  type WebRtcSignalPayload,
} from '@elm/protocol';

interface InviteRow extends Record<string, SqlStorageValue> {
  invite_id: string;
  requester_account_id: string;
  requester_friend_code: string;
  requester_display_name: string;
  target_account_id: string;
  target_friend_code: string;
  target_display_name: string;
  intent: string;
  host_media_selection_json: string;
  status: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

interface ActiveSessionRow extends Record<string, SqlStorageValue> {
  session_id: string;
  invite_id: string;
  host_account_id: string;
  host_friend_code: string;
  host_display_name: string;
  guest_account_id: string;
  guest_friend_code: string;
  guest_display_name: string;
  host_media_selection_json: string;
  created_at: string;
  last_host_heartbeat_at: string;
  last_guest_heartbeat_at: string;
}

interface TerminatedSessionRow extends Record<string, SqlStorageValue> {
  session_id: string;
  invite_id: string;
  host_account_id: string;
  guest_account_id: string;
  reason: string;
  sub_reason: string;
  initiated_by_account_id: string | null;
  terminated_at: string;
  duplicate_call_count: number;
  detection_time_ms: number;
}

interface SessionSignalRow extends Record<string, SqlStorageValue> {
  seq: number;
  signal_id: string;
  session_id: string;
  sender_account_id: string;
  target_account_id: string;
  payload_json: string;
  created_at: string;
}

function mapInviteRow(row: InviteRow): InviteSummary {
  const intent: InviteIntent = row.intent === 'invite' ? 'invite' : 'connect';
  let hostMediaSelection: HostMediaSelection | undefined;
  if (intent === 'invite') {
    try {
      hostMediaSelection = sanitizeHostMediaSelection(
        JSON.parse(row.host_media_selection_json || '{}') as Partial<HostMediaSelection>
      );
    } catch {
      hostMediaSelection = sanitizeHostMediaSelection({ screenVideo: true });
    }
  }
  const createdMs = Date.parse(row.created_at);
  const fallbackExpiresAt = Number.isFinite(createdMs)
    ? new Date(createdMs + INVITE_TIMEOUT_MS).toISOString()
    : row.created_at;
  return {
    inviteId: row.invite_id,
    requesterAccountId: row.requester_account_id,
    requesterFriendCode: row.requester_friend_code,
    requesterDisplayName: row.requester_display_name,
    targetAccountId: row.target_account_id,
    targetFriendCode: row.target_friend_code,
    targetDisplayName: row.target_display_name,
    intent,
    ...(hostMediaSelection ? { hostMediaSelection } : {}),
    status: row.status as InviteStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at || fallbackExpiresAt,
    resolvedAt: row.resolved_at,
  };
}

function mapSessionRow(row: ActiveSessionRow): ApprovedSessionSummary {
  let media: HostMediaSelection = {
    screenVideo: false,
    microphoneAudio: false,
    deviceAudio: false,
  };
  try {
    media = sanitizeHostMediaSelection(
      JSON.parse(row.host_media_selection_json) as Partial<HostMediaSelection>
    );
  } catch {
    // Use safe default OFF
  }
  return {
    sessionId: row.session_id,
    inviteId: row.invite_id,
    hostAccountId: row.host_account_id,
    hostFriendCode: row.host_friend_code,
    hostDisplayName: row.host_display_name,
    guestAccountId: row.guest_account_id,
    guestFriendCode: row.guest_friend_code,
    guestDisplayName: row.guest_display_name,
    hostMediaSelection: media,
    createdAt: row.created_at,
  };
}

function errorResponse(
  status: number,
  code: ProtocolErrorCode,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return Response.json(
    {
      error: code,
      message,
      ...extra,
    },
    { status }
  );
}

/**
 * SQLite-backed Durable Object coordinating authenticated presence, incoming/outgoing
 * Friend Code invites, and 1:1 session approval enforcement.
 */
export class SignalingCoordinator implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly socketsByAccount = new Map<string, Set<WebSocket>>();
  private readonly lookupRateWindows = new Map<string, number[]>();
  private readonly now: () => number;
  private schemaInitialized = false;

  constructor(
    state: DurableObjectState,
    _env: unknown,
    options?: { readonly now?: () => number }
  ) {
    this.state = state;
    this.now = options?.now ?? (() => Date.now());
  }

  private ensureSchema(): void {
    if (this.schemaInitialized) return;
    const sql = this.state.storage.sql;

    sql.exec(`
      CREATE TABLE IF NOT EXISTS presence_sessions (
        account_id TEXT PRIMARY KEY,
        friend_code TEXT NOT NULL,
        display_name TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invites (
        invite_id TEXT PRIMARY KEY,
        requester_account_id TEXT NOT NULL,
        requester_friend_code TEXT NOT NULL,
        requester_display_name TEXT NOT NULL,
        target_account_id TEXT NOT NULL,
        target_friend_code TEXT NOT NULL,
        target_display_name TEXT NOT NULL,
        intent TEXT NOT NULL DEFAULT 'connect',
        host_media_selection_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL DEFAULT '',
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS active_sessions (
        session_id TEXT PRIMARY KEY,
        invite_id TEXT NOT NULL UNIQUE,
        host_account_id TEXT NOT NULL UNIQUE,
        host_friend_code TEXT NOT NULL,
        host_display_name TEXT NOT NULL,
        guest_account_id TEXT NOT NULL UNIQUE,
        guest_friend_code TEXT NOT NULL,
        guest_display_name TEXT NOT NULL,
        host_media_selection_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_host_heartbeat_at TEXT NOT NULL,
        last_guest_heartbeat_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS terminated_sessions (
        session_id TEXT PRIMARY KEY,
        invite_id TEXT NOT NULL,
        host_account_id TEXT NOT NULL,
        guest_account_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        sub_reason TEXT NOT NULL,
        initiated_by_account_id TEXT,
        terminated_at TEXT NOT NULL,
        duplicate_call_count INTEGER NOT NULL DEFAULT 0,
        detection_time_ms INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS session_signals (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        sender_account_id TEXT NOT NULL,
        target_account_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // Idempotent column upgrades for existing Durable Object SQLite tables
    for (const stmt of [
      `ALTER TABLE invites ADD COLUMN intent TEXT NOT NULL DEFAULT 'connect'`,
      `ALTER TABLE invites ADD COLUMN host_media_selection_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE invites ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''`,
    ]) {
      try {
        sql.exec(stmt);
      } catch {
        // Column already exists
      }
    }

    this.schemaInitialized = true;
  }

  private isAccountOnline(
    accountId: string,
    nowMs: number = this.now()
  ): boolean {
    this.ensureSchema();
    const rows = this.state.storage.sql
      .exec<{ account_id: string; updated_at: string }>(
        `SELECT account_id, updated_at FROM presence_sessions WHERE account_id = ?`,
        accountId
      )
      .toArray();
    if (rows.length === 0) return false;
    const updatedMs = Date.parse(rows[0].updated_at);
    if (!Number.isFinite(updatedMs) || nowMs - updatedMs > PRESENCE_STALE_TIMEOUT_MS) {
      this.markAccountOffline(accountId, 'connection_lost', 'presence_stale');
      return false;
    }
    return true;
  }

  private refreshExistingPresence(
    account: AccountProfile,
    nowMs: number = this.now()
  ): void {
    if (!this.isAccountOnline(account.accountId, nowMs)) {
      return;
    }
    this.state.storage.sql.exec(
      `UPDATE presence_sessions SET updated_at = ? WHERE account_id = ?`,
      new Date(nowMs).toISOString(),
      account.accountId
    );
  }

  private checkLookupRateLimit(
    callerAccountId: string,
    nowMs: number = this.now()
  ): { readonly allowed: boolean; readonly retryAfterSec: number } {
    const cutoff = nowMs - PRESENCE_LOOKUP_RATE_LIMIT_WINDOW_MS;
    const prev = this.lookupRateWindows.get(callerAccountId) ?? [];
    const recent = prev.filter((ts) => ts > cutoff);
    if (recent.length >= PRESENCE_LOOKUP_RATE_LIMIT_MAX_REQUESTS) {
      const oldestMs = recent[0] ?? nowMs;
      const retryAfterMs = Math.max(
        1000,
        oldestMs + PRESENCE_LOOKUP_RATE_LIMIT_WINDOW_MS - nowMs
      );
      this.lookupRateWindows.set(callerAccountId, recent);
      return {
        allowed: false,
        retryAfterSec: Math.ceil(retryAfterMs / 1000),
      };
    }
    recent.push(nowMs);
    this.lookupRateWindows.set(callerAccountId, recent);
    return { allowed: true, retryAfterSec: 0 };
  }

  private pruneStalePresences(nowMs: number = this.now()): void {
    this.ensureSchema();
    const rows = this.state.storage.sql
      .exec<{ account_id: string; updated_at: string }>(
        `SELECT account_id, updated_at FROM presence_sessions`
      )
      .toArray();
    for (const row of rows) {
      const updatedMs = Date.parse(row.updated_at);
      if (!Number.isFinite(updatedMs) || nowMs - updatedMs > PRESENCE_STALE_TIMEOUT_MS) {
        this.markAccountOffline(row.account_id, 'connection_lost', 'presence_stale');
      }
    }
  }

  private expireStaleInvites(nowMs: number = this.now()): void {
    this.ensureSchema();
    this.pruneStalePresences(nowMs);
    const sql = this.state.storage.sql;
    const nowIso = new Date(nowMs).toISOString();
    const pendingRows = sql
      .exec<InviteRow>(`SELECT * FROM invites WHERE status = 'pending'`)
      .toArray();

    for (const row of pendingRows) {
      const expiresMs = row.expires_at
        ? Date.parse(row.expires_at)
        : Date.parse(row.created_at) + INVITE_TIMEOUT_MS;
      if (Number.isFinite(expiresMs) && nowMs >= expiresMs) {
        sql.exec(
          `UPDATE invites SET status = 'expired', resolved_at = ?
           WHERE invite_id = ? AND status = 'pending'`,
          nowIso,
          row.invite_id
        );
        const expired = mapInviteRow({
          ...row,
          status: 'expired',
          resolved_at: nowIso,
        });
        this.sendEventToAccount(row.requester_account_id, {
          type: 'invite:updated',
          invite: expired,
          reason: 'expired',
        });
        this.sendEventToAccount(row.target_account_id, {
          type: 'invite:updated',
          invite: expired,
          reason: 'expired',
        });
      }
    }
  }

  private getActiveSessionForAccount(
    accountId: string
  ): ApprovedSessionSummary | null {
    this.ensureSchema();
    const rows = this.state.storage.sql
      .exec<ActiveSessionRow>(
        `SELECT * FROM active_sessions
         WHERE host_account_id = ? OR guest_account_id = ?
         LIMIT 1`,
        accountId,
        accountId
      )
      .toArray();
    return rows.length > 0 ? mapSessionRow(rows[0]) : null;
  }

  private getPendingIncomingInvites(accountId: string): InviteSummary[] {
    this.expireStaleInvites();
    return this.state.storage.sql
      .exec<InviteRow>(
        `SELECT * FROM invites
         WHERE target_account_id = ? AND status = 'pending'
         ORDER BY created_at ASC, rowid ASC`,
        accountId
      )
      .toArray()
      .map(mapInviteRow);
  }

  private getPendingOutgoingInvite(accountId: string): InviteSummary | null {
    this.expireStaleInvites();
    const rows = this.state.storage.sql
      .exec<InviteRow>(
        `SELECT * FROM invites
         WHERE requester_account_id = ? AND status = 'pending'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
        accountId
      )
      .toArray();
    return rows.length > 0 ? mapInviteRow(rows[0]) : null;
  }

  private getRecentExpiredOutgoingInvite(accountId: string): InviteSummary | null {
    const latestRows = this.state.storage.sql
      .exec<InviteRow>(
        `SELECT * FROM invites
         WHERE requester_account_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
        accountId
      )
      .toArray();
    if (latestRows.length === 0) return null;
    const latest = latestRows[0];
    if (latest.status !== 'expired') return null;
    return mapInviteRow(latest);
  }

  private buildPresenceSnapshot(account: AccountProfile): PresenceStateSnapshot {
    this.ensureSchema();
    this.expireStaleInvites();
    const outgoingInvite = this.getPendingOutgoingInvite(account.accountId);
    const activeSession = this.getActiveSessionForAccount(account.accountId);
    return {
      online: this.isAccountOnline(account.accountId),
      account,
      incomingInvites: this.getPendingIncomingInvites(account.accountId),
      outgoingInvite,
      recentExpiredOutgoingInvite:
        !outgoingInvite && !activeSession
          ? this.getRecentExpiredOutgoingInvite(account.accountId)
          : null,
      activeSession,
    };
  }

  private sendEventToAccount(
    accountId: string,
    event: CoordinatorServerEvent
  ): void {
    const sockets = this.socketsByAccount.get(accountId);
    if (!sockets || sockets.size === 0) return;
    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Ignore closed socket errors
      }
    }
  }

  private markAccountOnline(account: AccountProfile): void {
    this.ensureSchema();
    const now = new Date(this.now()).toISOString();
    this.state.storage.sql.exec(
      `INSERT INTO presence_sessions (account_id, friend_code, display_name, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         friend_code = excluded.friend_code,
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`,
      account.accountId,
      account.friendCode,
      account.displayName,
      now,
      now
    );
  }

  private mapTerminatedReceipt(
    row: TerminatedSessionRow,
    alreadyEnded: boolean
  ): SessionTeardownReceipt {
    return {
      sessionId: row.session_id,
      reason: row.reason as SessionTerminationReason,
      subReason: row.sub_reason,
      initiatedByAccountId: row.initiated_by_account_id,
      terminatedAt: row.terminated_at,
      alreadyEnded,
      duplicateCallCount: row.duplicate_call_count,
      hostTracksStoppedCount: 0,
      peerConnectionsClosed: true,
      dataChannelsClosed: true,
      guestViewerCleared: true,
      permissionsInvalidated: true,
      signalingMembershipInvalidated: true,
      detectionTimeMs: row.detection_time_ms,
    };
  }

  /**
   * Unified idempotent session teardown path in SignalingCoordinator.
   * Called on:
   * - User A or User B top-bar Disconnect ('user_top_bar_disconnect')
   * - App close / quit ('app_closed')
   * - Detected connection loss / liveness timeout / sleep ('connection_lost')
   * Invalidates session permissions and signaling membership, records a tombstone
   * in `terminated_sessions` so stale events are rejected with `SESSION_ALREADY_ENDED`,
   * and guarantees duplicate teardown calls succeed idempotently.
   */
  private teardownSessionIdempotent(params: {
    sessionId?: string;
    callerAccountId?: string;
    reason: SessionTerminationReason;
    subReason?: string;
    detectionTimeMs?: number;
  }):
    | {
        ok: true;
        status: 200;
        disconnected: true;
        alreadyEnded: boolean;
        sessionId: string;
        receipt: SessionTeardownReceipt;
      }
    | {
        ok: false;
        status: number;
        code: ProtocolErrorCode;
        message: string;
      } {
    this.ensureSchema();
    const sql = this.state.storage.sql;

    let targetSessionId = params.sessionId;
    if (!targetSessionId && params.callerAccountId) {
      const activeForCaller = this.getActiveSessionForAccount(
        params.callerAccountId
      );
      if (activeForCaller) {
        targetSessionId = activeForCaller.sessionId;
      } else {
        const lastTerminated = sql
          .exec<TerminatedSessionRow>(
            `SELECT * FROM terminated_sessions
             WHERE host_account_id = ? OR guest_account_id = ?
             ORDER BY rowid DESC
             LIMIT 1`,
            params.callerAccountId,
            params.callerAccountId
          )
          .toArray();
        if (lastTerminated.length > 0) {
          targetSessionId = lastTerminated[0].session_id;
        }
      }
    }

    if (!targetSessionId) {
      return {
        ok: false,
        status: 403,
        code: 'UNAUTHORIZED_SESSION_PARTICIPANT',
        message: 'No matching active or recently ended session found for caller.',
      };
    }

    // 1. Check if session is currently active
    const activeRows = sql
      .exec<ActiveSessionRow>(
        `SELECT * FROM active_sessions WHERE session_id = ? LIMIT 1`,
        targetSessionId
      )
      .toArray();

    if (activeRows.length > 0) {
      const active = activeRows[0];
      if (
        params.callerAccountId &&
        active.host_account_id !== params.callerAccountId &&
        active.guest_account_id !== params.callerAccountId
      ) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED_SESSION_PARTICIPANT',
          message: 'Caller is not an approved participant of this 1:1 session.',
        };
      }

      const now = new Date(this.now()).toISOString();
      const subReason = params.subReason || params.reason;
      const detectionTimeMs = Math.max(1, Math.round(params.detectionTimeMs ?? 1));

      sql.exec(
        `DELETE FROM active_sessions WHERE session_id = ?`,
        active.session_id
      );
      sql.exec(
        `DELETE FROM session_signals WHERE session_id = ?`,
        active.session_id
      );

      sql.exec(
        `INSERT INTO terminated_sessions (
          session_id,
          invite_id,
          host_account_id,
          guest_account_id,
          reason,
          sub_reason,
          initiated_by_account_id,
          terminated_at,
          duplicate_call_count,
          detection_time_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          duplicate_call_count = terminated_sessions.duplicate_call_count + 1`,
        active.session_id,
        active.invite_id,
        active.host_account_id,
        active.guest_account_id,
        params.reason,
        subReason,
        params.callerAccountId ?? null,
        now,
        detectionTimeMs
      );

      const termRow: TerminatedSessionRow = {
        session_id: active.session_id,
        invite_id: active.invite_id,
        host_account_id: active.host_account_id,
        guest_account_id: active.guest_account_id,
        reason: params.reason,
        sub_reason: subReason,
        initiated_by_account_id: params.callerAccountId ?? null,
        terminated_at: now,
        duplicate_call_count: 0,
        detection_time_ms: detectionTimeMs,
      };
      const receipt = this.mapTerminatedReceipt(termRow, false);

      this.sendEventToAccount(active.host_account_id, {
        type: 'session:ended',
        sessionId: active.session_id,
        reason: params.reason,
        subReason,
        receipt,
      });
      this.sendEventToAccount(active.guest_account_id, {
        type: 'session:ended',
        sessionId: active.session_id,
        reason: params.reason,
        subReason,
        receipt,
      });

      return {
        ok: true,
        status: 200,
        disconnected: true,
        alreadyEnded: false,
        sessionId: active.session_id,
        receipt,
      };
    }

    // 2. Check if session was already terminated (idempotent duplicate teardown)
    const termRows = sql
      .exec<TerminatedSessionRow>(
        `SELECT * FROM terminated_sessions WHERE session_id = ? LIMIT 1`,
        targetSessionId
      )
      .toArray();

    if (termRows.length > 0) {
      const term = termRows[0];
      if (
        params.callerAccountId &&
        term.host_account_id !== params.callerAccountId &&
        term.guest_account_id !== params.callerAccountId
      ) {
        return {
          ok: false,
          status: 403,
          code: 'UNAUTHORIZED_SESSION_PARTICIPANT',
          message: 'Caller was not a participant of this session.',
        };
      }

      const nextCount = Number(term.duplicate_call_count ?? 0) + 1;
      sql.exec(
        `UPDATE terminated_sessions SET duplicate_call_count = ? WHERE session_id = ?`,
        nextCount,
        term.session_id
      );

      const updatedRow: TerminatedSessionRow = {
        ...term,
        duplicate_call_count: nextCount,
      };
      const receipt = this.mapTerminatedReceipt(updatedRow, true);

      return {
        ok: true,
        status: 200,
        disconnected: true,
        alreadyEnded: true,
        sessionId: term.session_id,
        receipt,
      };
    }

    return {
      ok: false,
      status: 403,
      code: 'UNAUTHORIZED_SESSION_PARTICIPANT',
      message: 'No matching active session found for caller.',
    };
  }

  private markAccountOffline(
    accountId: string,
    reason: SessionTerminationReason = 'connection_lost',
    subReason: string = 'peer_offline'
  ): SessionTeardownReceipt | null {
    this.ensureSchema();
    const sql = this.state.storage.sql;
    const now = new Date(this.now()).toISOString();

    sql.exec(`DELETE FROM presence_sessions WHERE account_id = ?`, accountId);

    // Cancel any pending invites involving this account
    const pendingRows = sql
      .exec<InviteRow>(
        `SELECT * FROM invites
         WHERE (requester_account_id = ? OR target_account_id = ?)
           AND status = 'pending'`,
        accountId,
        accountId
      )
      .toArray();

    for (const row of pendingRows) {
      sql.exec(
        `UPDATE invites SET status = 'cancelled', resolved_at = ? WHERE invite_id = ?`,
        now,
        row.invite_id
      );
      const updated = mapInviteRow({
        ...row,
        status: 'cancelled',
        resolved_at: now,
      });
      this.sendEventToAccount(row.requester_account_id, {
        type: 'invite:updated',
        invite: updated,
        reason: 'peer_offline',
      });
      this.sendEventToAccount(row.target_account_id, {
        type: 'invite:updated',
        invite: updated,
        reason: 'peer_offline',
      });
    }

    // End any active session involving this account via the single idempotent teardown path
    const activeSession = this.getActiveSessionForAccount(accountId);
    if (activeSession) {
      const res = this.teardownSessionIdempotent({
        sessionId: activeSession.sessionId,
        callerAccountId: accountId,
        reason,
        subReason,
      });
      return res.ok ? res.receipt : null;
    }
    return null;
  }

  private recordAndDeliverSignal(
    session: ApprovedSessionSummary,
    senderAccountId: string,
    payload: WebRtcSignalPayload
  ): WebRtcSignalEnvelope {
    this.ensureSchema();
    const sql = this.state.storage.sql;
    const targetAccountId =
      senderAccountId === session.hostAccountId
        ? session.guestAccountId
        : session.hostAccountId;
    const signalId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    sql.exec(
      `INSERT INTO session_signals (
        signal_id,
        session_id,
        sender_account_id,
        target_account_id,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      signalId,
      session.sessionId,
      senderAccountId,
      targetAccountId,
      JSON.stringify(payload),
      createdAt
    );

    const rows = sql
      .exec<{ seq: number }>(
        `SELECT seq FROM session_signals WHERE signal_id = ? LIMIT 1`,
        signalId
      )
      .toArray();
    const seq = rows[0]?.seq ?? 0;

    const envelope: WebRtcSignalEnvelope = {
      seq,
      signalId,
      sessionId: session.sessionId,
      senderAccountId,
      targetAccountId,
      payload,
      createdAt,
    };

    this.sendEventToAccount(targetAccountId, {
      type: 'session:signal',
      envelope,
    });

    return envelope;
  }

  private handleWebSocketUpgrade(
    request: Request,
    account: AccountProfile
  ): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];

    serverSocket.accept();

    let accountSockets = this.socketsByAccount.get(account.accountId);
    if (!accountSockets) {
      accountSockets = new Set<WebSocket>();
      this.socketsByAccount.set(account.accountId, accountSockets);
    }
    accountSockets.add(serverSocket);

    this.markAccountOnline(account);

    // Send initial presence snapshot immediately
    serverSocket.send(
      JSON.stringify({
        type: 'presence:snapshot',
        snapshot: this.buildPresenceSnapshot(account),
      } satisfies CoordinatorServerEvent)
    );

    serverSocket.addEventListener('message', (msgEvent) => {
      try {
        const text =
          typeof msgEvent.data === 'string'
            ? msgEvent.data
            : new TextDecoder().decode(msgEvent.data as ArrayBuffer);
        const parsed = JSON.parse(text) as {
          type?: string;
          sessionId?: string;
          friendCode?: string;
          payload?: WebRtcSignalPayload;
        };

        if (parsed.type === 'presence:ping') {
          this.markAccountOnline(account);
          serverSocket.send(
            JSON.stringify({
              type: 'presence:snapshot',
              snapshot: this.buildPresenceSnapshot(account),
            } satisfies CoordinatorServerEvent)
          );
          return;
        }

        // Enforce signaling gate on WebSocket messages
        if (
          parsed.type?.startsWith('webrtc:') ||
          parsed.type?.startsWith('signal:') ||
          parsed.type === 'session:signal'
        ) {
          const check = this.evaluateSignalingGate(
            account.accountId,
            parsed.sessionId,
            parsed.friendCode
          );
          if (!check.allowed) {
            serverSocket.send(
              JSON.stringify({
                type: 'error',
                code: check.code,
                message: check.message,
              } satisfies CoordinatorServerEvent)
            );
            return;
          }

          if (parsed.payload && typeof parsed.payload.type === 'string') {
            this.recordAndDeliverSignal(
              check.session,
              account.accountId,
              parsed.payload
            );
          }
        }
      } catch {
        // Ignore malformed client frames
      }
    });

    const cleanupSocket = () => {
      const set = this.socketsByAccount.get(account.accountId);
      if (set) {
        set.delete(serverSocket);
        if (set.size === 0) {
          this.socketsByAccount.delete(account.accountId);
          this.markAccountOffline(account.accountId, 'connection_lost');
        }
      }
    };

    serverSocket.addEventListener('close', cleanupSocket);
    serverSocket.addEventListener('error', cleanupSocket);

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  private evaluateSignalingGate(
    callerAccountId: string,
    sessionId?: string,
    attemptedFriendCode?: string
  ):
    | { allowed: true; session: ApprovedSessionSummary }
    | { allowed: false; status: number; code: ProtocolErrorCode; message: string } {
    this.ensureSchema();

    // 1. Knowing a Friend Code NEVER grants permission to join or signal an approved session
    if (attemptedFriendCode && !sessionId) {
      return {
        allowed: false,
        status: 403,
        code: 'UNAUTHORIZED_SESSION_PARTICIPANT',
        message:
          'Knowing a Friend Code does not grant access to join or signal a session.',
      };
    }

    // 2. If a specific sessionId is targeted, check if that approved session exists
    if (sessionId) {
      const rows = this.state.storage.sql
        .exec<ActiveSessionRow>(
          `SELECT * FROM active_sessions WHERE session_id = ? LIMIT 1`,
          sessionId
        )
        .toArray();

      if (rows.length === 0) {
        const terminatedRows = this.state.storage.sql
          .exec<TerminatedSessionRow>(
            `SELECT * FROM terminated_sessions WHERE session_id = ? LIMIT 1`,
            sessionId
          )
          .toArray();

        if (terminatedRows.length > 0) {
          const term = terminatedRows[0];
          if (
            term.host_account_id !== callerAccountId &&
            term.guest_account_id !== callerAccountId
          ) {
            return {
              allowed: false,
              status: 403,
              code: 'UNAUTHORIZED_SESSION_PARTICIPANT',
              message:
                'Caller is not an approved participant of this 1:1 session. Knowing a Friend Code cannot join an approved session.',
            };
          }
          return {
            allowed: false,
            status: 409,
            code: 'SESSION_ALREADY_ENDED',
            message: `Stale session event rejected: session ${sessionId} has already ended (${term.reason}) and can never be resumed. Send a fresh invite and accept again.`,
          };
        }

        return {
          allowed: false,
          status: 403,
          code: 'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE',
          message:
            'No signaling is admitted before an invite is explicitly accepted by the intended owner.',
        };
      }

      const session = rows[0];
      if (
        session.host_account_id !== callerAccountId &&
        session.guest_account_id !== callerAccountId
      ) {
        return {
          allowed: false,
          status: 403,
          code: 'UNAUTHORIZED_SESSION_PARTICIPANT',
          message:
            'Caller is not an approved participant of this 1:1 session. Knowing a Friend Code cannot join an approved session.',
        };
      }

      return {
        allowed: true,
        session: mapSessionRow(session),
      };
    }

    // 3. No sessionId provided: check if caller has any approved session at all
    const callerSession = this.getActiveSessionForAccount(callerAccountId);
    if (!callerSession) {
      return {
        allowed: false,
        status: 403,
        code: 'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE',
        message:
          'No signaling is admitted while idle or while an invite is pending/declined.',
      };
    }

    return {
      allowed: true,
      session: callerSession,
    };
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    const sql = this.state.storage.sql;

    // WebSocket Upgrade for real-time presence & invite notifications
    if (url.pathname === '/internal/ws') {
      const accountHeader = request.headers.get('X-Elm-Account-Json');
      if (!accountHeader) {
        return errorResponse(401, 'UNAUTHORIZED', 'Missing authenticated account.');
      }
      const account = JSON.parse(accountHeader) as AccountProfile;
      return this.handleWebSocketUpgrade(request, account);
    }

    // Connect Presence
    if (request.method === 'POST' && url.pathname === '/internal/presence/connect') {
      const body = (await request.json()) as { account: AccountProfile };
      this.markAccountOnline(body.account);
      return Response.json({
        snapshot: this.buildPresenceSnapshot(body.account),
        serverTime: new Date(this.now()).toISOString(),
      });
    }

    // Presence Heartbeat (server-timestamped freshness refresh & auto-recovery)
    if (request.method === 'POST' && url.pathname === '/internal/presence/heartbeat') {
      const body = (await request.json()) as { account: AccountProfile };
      this.markAccountOnline(body.account);
      return Response.json({
        snapshot: this.buildPresenceSnapshot(body.account),
        serverTime: new Date(this.now()).toISOString(),
      });
    }

    // Disconnect Presence
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/presence/disconnect'
    ) {
      const body = (await request.json()) as {
        accountId: string;
        reason?: SessionTerminationReason;
        subReason?: string;
      };
      const receipt = this.markAccountOffline(
        body.accountId,
        body.reason ?? 'user_top_bar_disconnect',
        body.subReason ?? body.reason ?? 'user_top_bar_disconnect'
      );
      return Response.json({ ok: true, receipt });
    }

    // Get Presence & Session State Snapshot
    if (request.method === 'POST' && url.pathname === '/internal/presence/state') {
      const body = (await request.json()) as { account: AccountProfile };
      this.refreshExistingPresence(body.account);
      return Response.json({
        snapshot: this.buildPresenceSnapshot(body.account),
        serverTime: new Date(this.now()).toISOString(),
      });
    }

    // Batch Presence Lookup for Saved/Recent Peer Codes (authenticated & rate-limited)
    if (request.method === 'POST' && url.pathname === '/internal/presence/lookup') {
      const body = (await request.json()) as {
        callerAccountId?: string;
        requestedCodes?: string[];
        accounts: Array<{ accountId: string; friendCode: string }>;
      };
      if (body.callerAccountId) {
        const rate = this.checkLookupRateLimit(body.callerAccountId);
        if (!rate.allowed) {
          return Response.json(
            {
              error: 'RATE_LIMITED',
              message:
                'Too many presence lookup requests. Please wait a moment and try again.',
            },
            {
              status: 429,
              headers: { 'Retry-After': String(rate.retryAfterSec) },
            }
          );
        }
      }
      const statuses: Record<string, boolean> = {};
      for (const code of body.requestedCodes ?? []) {
        statuses[code] = false;
      }
      for (const acc of body.accounts ?? []) {
        statuses[acc.friendCode] = this.isAccountOnline(acc.accountId);
      }
      return Response.json({
        statuses,
        serverTime: new Date(this.now()).toISOString(),
      });
    }

    // Create Invite (Connect = ask to view friend's screen; Invite = ask friend to view your screen)
    if (request.method === 'POST' && url.pathname === '/internal/invites/create') {
      const body = (await request.json()) as {
        requester: AccountProfile;
        target: AccountProfile;
        intent?: InviteIntent;
        hostMediaSelection?: Partial<HostMediaSelection>;
        expiresInMs?: number;
      };
      const { requester, target } = body;
      const intent: InviteIntent = body.intent === 'invite' ? 'invite' : 'connect';
      const inviteMediaSelection =
        intent === 'invite'
          ? sanitizeHostMediaSelection({
              screenVideo: body.hostMediaSelection?.screenVideo ?? true,
              microphoneAudio: body.hostMediaSelection?.microphoneAudio ?? false,
              deviceAudio: body.hostMediaSelection?.deviceAudio ?? false,
            })
          : sanitizeHostMediaSelection(null);
      this.expireStaleInvites();

      // 1. Self-invite check
      if (
        requester.accountId === target.accountId ||
        requester.friendCode === target.friendCode
      ) {
        return errorResponse(
          400,
          'SELF_INVITE_NOT_ALLOWED',
          'You cannot send a session invite to your own Friend Code.'
        );
      }

      // 2. Ensure requester is marked online when actively sending an invite
      if (!this.isAccountOnline(requester.accountId)) {
        this.markAccountOnline(requester);
      }

      // 3. Enforce one active 1:1 session per user (check both requester and target)
      const requesterActiveSession = this.getActiveSessionForAccount(
        requester.accountId
      );
      if (requesterActiveSession) {
        return errorResponse(
          409,
          'USER_ALREADY_IN_ACTIVE_SESSION',
          'You are already in an active 1:1 session. Disconnect first before sending a new invite.'
        );
      }

      const targetActiveSession = this.getActiveSessionForAccount(
        target.accountId
      );
      if (targetActiveSession) {
        return errorResponse(
          409,
          'USER_ALREADY_IN_ACTIVE_SESSION',
          'The owner of this Friend Code is already in another active 1:1 session.'
        );
      }

      // 4. Offline owner check
      if (!this.isAccountOnline(target.accountId)) {
        return errorResponse(
          409,
          'TARGET_OFFLINE',
          'The owner of this Friend Code is currently offline.'
        );
      }

      // 5. Duplicate request check (same requester -> same target)
      const duplicateRows = sql
        .exec<InviteRow>(
          `SELECT * FROM invites
           WHERE requester_account_id = ?
             AND target_account_id = ?
             AND status = 'pending'
           LIMIT 1`,
          requester.accountId,
          target.accountId
        )
        .toArray();

      if (duplicateRows.length > 0) {
        return errorResponse(
          409,
          'DUPLICATE_PENDING_INVITE',
          'An invite to this Friend Code is already pending response.',
          { invite: mapInviteRow(duplicateRows[0]) }
        );
      }

      // 6. Single outgoing pending invite per requester
      const existingOutgoing = this.getPendingOutgoingInvite(
        requester.accountId
      );
      if (existingOutgoing) {
        return errorResponse(
          409,
          'OUTGOING_INVITE_ALREADY_PENDING',
          'You already have a pending outgoing invite. Wait for a response or cancel it first.',
          { invite: existingOutgoing }
        );
      }

      const inviteId = crypto.randomUUID();
      const nowMs = this.now();
      const now = new Date(nowMs).toISOString();
      const ttlMs =
        typeof body.expiresInMs === 'number' &&
        Number.isFinite(body.expiresInMs) &&
        body.expiresInMs > 0 &&
        body.expiresInMs <= INVITE_TIMEOUT_MS
          ? body.expiresInMs
          : INVITE_TIMEOUT_MS;
      const expiresAt = new Date(nowMs + ttlMs).toISOString();

      sql.exec(
        `INSERT INTO invites (
          invite_id,
          requester_account_id,
          requester_friend_code,
          requester_display_name,
          target_account_id,
          target_friend_code,
          target_display_name,
          intent,
          host_media_selection_json,
          status,
          created_at,
          expires_at,
          resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
        inviteId,
        requester.accountId,
        requester.friendCode,
        requester.displayName,
        target.accountId,
        target.friendCode,
        target.displayName,
        intent,
        JSON.stringify(inviteMediaSelection),
        now,
        expiresAt
      );

      const invite: InviteSummary = {
        inviteId,
        requesterAccountId: requester.accountId,
        requesterFriendCode: requester.friendCode,
        requesterDisplayName: requester.displayName,
        targetAccountId: target.accountId,
        targetFriendCode: target.friendCode,
        targetDisplayName: target.displayName,
        intent,
        ...(intent === 'invite' ? { hostMediaSelection: inviteMediaSelection } : {}),
        status: 'pending',
        createdAt: now,
        expiresAt,
        resolvedAt: null,
      };

      // Notify intended recipient in real time
      this.sendEventToAccount(target.accountId, {
        type: 'invite:incoming',
        invite,
      });

      return Response.json(
        {
          invite,
          snapshot: this.buildPresenceSnapshot(requester),
        },
        { status: 201 }
      );
    }

    // Cancel Outgoing Invite (Sender only)
    if (request.method === 'POST' && url.pathname === '/internal/invites/cancel') {
      const body = (await request.json()) as {
        caller: AccountProfile;
        inviteId: string;
      };
      this.expireStaleInvites();

      const rows = sql
        .exec<InviteRow>(
          `SELECT * FROM invites WHERE invite_id = ? LIMIT 1`,
          body.inviteId
        )
        .toArray();

      if (rows.length === 0) {
        return errorResponse(404, 'INVITE_NOT_FOUND', 'Invite not found.');
      }
      const inviteRow = rows[0];

      if (body.caller.accountId !== inviteRow.requester_account_id) {
        return errorResponse(
          403,
          'NOT_INVITE_SENDER',
          'Only the request sender can cancel a pending request.'
        );
      }

      if (inviteRow.status === 'expired') {
        return errorResponse(
          409,
          'INVITE_EXPIRED',
          'This connection request has already expired.'
        );
      }

      if (inviteRow.status !== 'pending') {
        return errorResponse(
          409,
          'INVITE_ALREADY_RESOLVED',
          `Invite has already been ${inviteRow.status}.`
        );
      }

      const now = new Date(this.now()).toISOString();
      sql.exec(
        `UPDATE invites SET status = 'cancelled', resolved_at = ?
         WHERE invite_id = ? AND status = 'pending'`,
        now,
        inviteRow.invite_id
      );

      const cancelledInvite = mapInviteRow({
        ...inviteRow,
        status: 'cancelled',
        resolved_at: now,
      });

      this.sendEventToAccount(inviteRow.requester_account_id, {
        type: 'invite:updated',
        invite: cancelledInvite,
        reason: 'cancelled_by_sender',
      });
      this.sendEventToAccount(inviteRow.target_account_id, {
        type: 'invite:updated',
        invite: cancelledInvite,
        reason: 'cancelled_by_sender',
      });

      return Response.json({
        invite: cancelledInvite,
        snapshot: this.buildPresenceSnapshot(body.caller),
      });
    }

    // Respond to Invite (Target accepts or declines)
    if (request.method === 'POST' && url.pathname === '/internal/invites/respond') {
      const body = (await request.json()) as {
        responder: AccountProfile;
        inviteId: string;
        action: 'accept' | 'decline';
        mediaSelection?: Partial<HostMediaSelection>;
      };
      this.expireStaleInvites();

      const rows = sql
        .exec<InviteRow>(
          `SELECT * FROM invites WHERE invite_id = ? LIMIT 1`,
          body.inviteId
        )
        .toArray();

      if (rows.length === 0) {
        return errorResponse(
          404,
          'INVITE_NOT_FOUND',
          'Invite not found.'
        );
      }

      const inviteRow = rows[0];

      // 1. Accept/Decline ONLY from the intended recipient
      if (body.responder.accountId !== inviteRow.target_account_id) {
        return errorResponse(
          403,
          'NOT_INVITE_OWNER',
          'Only the intended Friend Code owner (User A) can accept or decline this invite.'
        );
      }

      // 2. Expired or already resolved invite check (single outcome guarantee)
      if (inviteRow.status === 'expired') {
        return errorResponse(
          409,
          'INVITE_EXPIRED',
          'This connection request has expired.'
        );
      }

      if (inviteRow.status !== 'pending') {
        return errorResponse(
          409,
          'INVITE_ALREADY_RESOLVED',
          `Invite has already been ${inviteRow.status}.`
        );
      }

      const now = new Date(this.now()).toISOString();

      if (body.action === 'decline') {
        sql.exec(
          `UPDATE invites SET status = 'declined', resolved_at = ? WHERE invite_id = ?`,
          now,
          inviteRow.invite_id
        );

        const declinedInvite = mapInviteRow({
          ...inviteRow,
          status: 'declined',
          resolved_at: now,
        });

        this.sendEventToAccount(inviteRow.requester_account_id, {
          type: 'invite:updated',
          invite: declinedInvite,
          reason: 'declined_by_owner',
        });
        this.sendEventToAccount(inviteRow.target_account_id, {
          type: 'invite:updated',
          invite: declinedInvite,
          reason: 'declined_by_owner',
        });

        return Response.json({
          invite: declinedInvite,
          session: null,
          snapshot: this.buildPresenceSnapshot(body.responder),
        });
      }

      // action === 'accept'
      // 3. Enforce one active 1:1 session per user & simultaneous accept race protection
      const hostExistingSession = this.getActiveSessionForAccount(
        inviteRow.target_account_id
      );
      if (hostExistingSession) {
        return errorResponse(
          409,
          'USER_ALREADY_IN_ACTIVE_SESSION',
          'Host is already in an active 1:1 session. Only one active session per user is permitted.'
        );
      }

      const guestExistingSession = this.getActiveSessionForAccount(
        inviteRow.requester_account_id
      );
      if (guestExistingSession) {
        sql.exec(
          `UPDATE invites SET status = 'cancelled', resolved_at = ? WHERE invite_id = ?`,
          now,
          inviteRow.invite_id
        );
        return errorResponse(
          409,
          'USER_ALREADY_IN_ACTIVE_SESSION',
          'Requester is already in another active 1:1 session.'
        );
      }

      // 4. Verify requester is still online
      if (!this.isAccountOnline(inviteRow.requester_account_id)) {
        sql.exec(
          `UPDATE invites SET status = 'cancelled', resolved_at = ? WHERE invite_id = ?`,
          now,
          inviteRow.invite_id
        );
        return errorResponse(
          409,
          'TARGET_OFFLINE',
          'The requester went offline before the invite was accepted.'
        );
      }

      // 5. Role & media consent assignment based on request intent:
      // - 'connect': target is Host, requester is Viewer (target chooses HostMediaSelection)
      // - 'invite':  requester (sender) is Host, target (recipient) is Viewer
      const isReverseInvite = inviteRow.intent === 'invite';
      let hostPresetSelection: Partial<HostMediaSelection> | undefined;
      if (isReverseInvite) {
        try {
          hostPresetSelection = JSON.parse(
            inviteRow.host_media_selection_json || '{}'
          ) as Partial<HostMediaSelection>;
        } catch {
          hostPresetSelection = { screenVideo: true };
        }
      }
      const mediaSelection = isReverseInvite
        ? sanitizeHostMediaSelection({
            screenVideo: hostPresetSelection?.screenVideo ?? true,
            microphoneAudio: hostPresetSelection?.microphoneAudio ?? false,
            deviceAudio: hostPresetSelection?.deviceAudio ?? false,
          })
        : sanitizeHostMediaSelection(body.mediaSelection);

      const hostAccountId = isReverseInvite
        ? inviteRow.requester_account_id
        : inviteRow.target_account_id;
      const hostFriendCode = isReverseInvite
        ? inviteRow.requester_friend_code
        : inviteRow.target_friend_code;
      const hostDisplayName = isReverseInvite
        ? inviteRow.requester_display_name
        : inviteRow.target_display_name;
      const guestAccountId = isReverseInvite
        ? inviteRow.target_account_id
        : inviteRow.requester_account_id;
      const guestFriendCode = isReverseInvite
        ? inviteRow.target_friend_code
        : inviteRow.requester_friend_code;
      const guestDisplayName = isReverseInvite
        ? inviteRow.target_display_name
        : inviteRow.requester_display_name;

      const sessionId = crypto.randomUUID();

      sql.exec(
        `UPDATE invites SET status = 'accepted', resolved_at = ? WHERE invite_id = ?`,
        now,
        inviteRow.invite_id
      );

      sql.exec(
        `INSERT INTO active_sessions (
          session_id,
          invite_id,
          host_account_id,
          host_friend_code,
          host_display_name,
          guest_account_id,
          guest_friend_code,
          guest_display_name,
          host_media_selection_json,
          created_at,
          last_host_heartbeat_at,
          last_guest_heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        inviteRow.invite_id,
        hostAccountId,
        hostFriendCode,
        hostDisplayName,
        guestAccountId,
        guestFriendCode,
        guestDisplayName,
        JSON.stringify(mediaSelection),
        now,
        now,
        now
      );

      // 6. Cancel all other pending invites involving either User A or User B
      const otherPending = sql
        .exec<InviteRow>(
          `SELECT * FROM invites
           WHERE status = 'pending'
             AND invite_id != ?
             AND (
               requester_account_id IN (?, ?)
               OR target_account_id IN (?, ?)
             )`,
          inviteRow.invite_id,
          inviteRow.target_account_id,
          inviteRow.requester_account_id,
          inviteRow.target_account_id,
          inviteRow.requester_account_id
        )
        .toArray();

      for (const other of otherPending) {
        sql.exec(
          `UPDATE invites SET status = 'cancelled', resolved_at = ? WHERE invite_id = ?`,
          now,
          other.invite_id
        );
        const cancelledSummary = mapInviteRow({
          ...other,
          status: 'cancelled',
          resolved_at: now,
        });
        this.sendEventToAccount(other.requester_account_id, {
          type: 'invite:updated',
          invite: cancelledSummary,
          reason: 'participant_entered_active_session',
        });
        this.sendEventToAccount(other.target_account_id, {
          type: 'invite:updated',
          invite: cancelledSummary,
          reason: 'participant_entered_active_session',
        });
      }

      const acceptedInvite = mapInviteRow({
        ...inviteRow,
        status: 'accepted',
        resolved_at: now,
      });

      const approvedSession: ApprovedSessionSummary = {
        sessionId,
        inviteId: inviteRow.invite_id,
        hostAccountId,
        hostFriendCode,
        hostDisplayName,
        guestAccountId,
        guestFriendCode,
        guestDisplayName,
        hostMediaSelection: mediaSelection,
        createdAt: now,
      };

      this.sendEventToAccount(inviteRow.requester_account_id, {
        type: 'invite:updated',
        invite: acceptedInvite,
        reason: 'accepted_by_owner',
      });
      this.sendEventToAccount(inviteRow.requester_account_id, {
        type: 'session:approved',
        session: approvedSession,
      });
      this.sendEventToAccount(inviteRow.target_account_id, {
        type: 'session:approved',
        session: approvedSession,
      });

      return Response.json({
        invite: acceptedInvite,
        session: approvedSession,
        snapshot: this.buildPresenceSnapshot(body.responder),
      });
    }

    // Disconnect Active Session (Single idempotent teardown path; ends session for both participants; never resumable)
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/sessions/disconnect'
    ) {
      const body = (await request.json()) as {
        caller: AccountProfile;
        sessionId?: string;
        reason?: SessionTerminationReason;
        subReason?: string;
        detectionTimeMs?: number;
      };

      const result = this.teardownSessionIdempotent({
        sessionId: body.sessionId,
        callerAccountId: body.caller.accountId,
        reason: body.reason ?? 'user_top_bar_disconnect',
        subReason: body.subReason,
        detectionTimeMs: body.detectionTimeMs,
      });

      if (!result.ok) {
        return errorResponse(result.status, result.code, result.message);
      }

      return Response.json({
        disconnected: true,
        alreadyEnded: result.alreadyEnded,
        sessionId: result.sessionId,
        receipt: result.receipt,
      });
    }

    // Liveness Heartbeat from Approved Session Participant
    // Note: Liveness threshold is NOT a time limit on a connected session;
    // sessions stay connected indefinitely as long as heartbeats arrive.
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/sessions/heartbeat'
    ) {
      const body = (await request.json()) as {
        caller: AccountProfile;
        sessionId?: string;
        timestampIso?: string;
      };

      const gate = this.evaluateSignalingGate(
        body.caller.accountId,
        body.sessionId
      );
      if (!gate.allowed) {
        return errorResponse(gate.status, gate.code, gate.message);
      }

      const nowIso = body.timestampIso || new Date(this.now()).toISOString();
      const isHost = body.caller.accountId === gate.session.hostAccountId;

      if (isHost) {
        sql.exec(
          `UPDATE active_sessions SET last_host_heartbeat_at = ? WHERE session_id = ?`,
          nowIso,
          gate.session.sessionId
        );
      } else {
        sql.exec(
          `UPDATE active_sessions SET last_guest_heartbeat_at = ? WHERE session_id = ?`,
          nowIso,
          gate.session.sessionId
        );
      }

      return Response.json({
        ok: true,
        sessionId: gate.session.sessionId,
        role: isHost ? 'host' : 'guest',
        heartbeatAt: nowIso,
      });
    }

    // Liveness Check: Detects abrupt connection loss (force quit, internet drop, sleep)
    // when a close event cannot arrive, and invokes the unified idempotent teardown path.
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/sessions/check-liveness'
    ) {
      const body = (await request.json()) as {
        caller: AccountProfile;
        sessionId?: string;
        nowIso?: string;
        livenessTimeoutMs?: number;
      };

      const targetSessionId =
        body.sessionId ||
        this.getActiveSessionForAccount(body.caller.accountId)?.sessionId;

      if (!targetSessionId) {
        return errorResponse(
          403,
          'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE',
          'No active session found to check liveness.'
        );
      }

      const activeRows = sql
        .exec<ActiveSessionRow>(
          `SELECT * FROM active_sessions WHERE session_id = ? LIMIT 1`,
          targetSessionId
        )
        .toArray();

      if (activeRows.length === 0) {
        const termRows = sql
          .exec<TerminatedSessionRow>(
            `SELECT * FROM terminated_sessions WHERE session_id = ? LIMIT 1`,
            targetSessionId
          )
          .toArray();
        if (termRows.length > 0) {
          const term = termRows[0];
          if (
            term.host_account_id !== body.caller.accountId &&
            term.guest_account_id !== body.caller.accountId
          ) {
            return errorResponse(
              403,
              'UNAUTHORIZED_SESSION_PARTICIPANT',
              'Caller is not a participant of this session.'
            );
          }
          return Response.json({
            alive: false,
            alreadyEnded: true,
            sessionId: term.session_id,
            receipt: this.mapTerminatedReceipt(term, true),
          });
        }

        return errorResponse(
          403,
          'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE',
          'Session not found.'
        );
      }

      const active = activeRows[0];
      if (
        active.host_account_id !== body.caller.accountId &&
        active.guest_account_id !== body.caller.accountId
      ) {
        return errorResponse(
          403,
          'UNAUTHORIZED_SESSION_PARTICIPANT',
          'Caller is not an approved participant of this 1:1 session.'
        );
      }

      const nowMs = body.nowIso ? Date.parse(body.nowIso) : this.now();
      const timeoutMs =
        body.livenessTimeoutMs ?? DEFAULT_LIVENESS_CONFIG.livenessTimeoutMs;
      const hostAgeMs = Math.max(
        0,
        nowMs - Date.parse(active.last_host_heartbeat_at)
      );
      const guestAgeMs = Math.max(
        0,
        nowMs - Date.parse(active.last_guest_heartbeat_at)
      );
      const sessionDurationMs = Math.max(
        0,
        nowMs - Date.parse(active.created_at)
      );

      const hostExpired = hostAgeMs > timeoutMs;
      const guestExpired = guestAgeMs > timeoutMs;

      if (hostExpired || guestExpired) {
        const subReason =
          hostExpired && guestExpired
            ? 'liveness_timeout_both_peers'
            : hostExpired
            ? 'liveness_timeout_host_a'
            : 'liveness_timeout_guest_b';
        const teardown = this.teardownSessionIdempotent({
          sessionId: active.session_id,
          callerAccountId: body.caller.accountId,
          reason: 'connection_lost',
          subReason,
          detectionTimeMs: Math.max(hostAgeMs, guestAgeMs),
        });
        if (!teardown.ok) {
          return errorResponse(teardown.status, teardown.code, teardown.message);
        }
        return Response.json({
          alive: false,
          alreadyEnded: teardown.alreadyEnded,
          sessionId: active.session_id,
          hostHeartbeatAgeMs: hostAgeMs,
          guestHeartbeatAgeMs: guestAgeMs,
          livenessTimeoutMs: timeoutMs,
          sessionDurationMs,
          receipt: teardown.receipt,
        });
      }

      return Response.json({
        alive: true,
        sessionId: active.session_id,
        hostHeartbeatAgeMs: hostAgeMs,
        guestHeartbeatAgeMs: guestAgeMs,
        livenessTimeoutMs: timeoutMs,
        sessionDurationMs,
      });
    }

    // Security Gate & WebRTC Signaling Endpoint: Join or Signal Session
    // Verifies:
    // 1. Knowing a Friend Code cannot join an approved session.
    // 2. No signaling is admitted before acceptance.
    // 3. Only approved participants (Host A or Guest B) can exchange SDP/ICE/media-status signals.
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/sessions/join-or-signal'
    ) {
      const body = (await request.json()) as {
        caller: AccountProfile;
        sessionId?: string;
        friendCode?: string;
        signalType?: string;
        payload?: WebRtcSignalPayload;
      };

      const gate = this.evaluateSignalingGate(
        body.caller.accountId,
        body.sessionId,
        body.friendCode
      );
      if (!gate.allowed) {
        return errorResponse(gate.status, gate.code, gate.message);
      }

      if (body.payload) {
        const pType = body.payload.type;
        if (
          pType !== 'offer' &&
          pType !== 'answer' &&
          pType !== 'ice-candidate' &&
          pType !== 'media-status' &&
          pType !== 'teardown'
        ) {
          return errorResponse(
            400,
            'INVALID_SIGNAL_PAYLOAD',
            'Worker only accepts WebRTC signaling payloads (offer, answer, ice-candidate, media-status, teardown), never media frames or chat payloads.'
          );
        }

        const envelope = this.recordAndDeliverSignal(
          gate.session,
          body.caller.accountId,
          body.payload
        );
        return Response.json({
          admitted: true,
          session: gate.session,
          envelope,
        });
      }

      return Response.json({
        admitted: true,
        session: gate.session,
      });
    }

    // Poll / Dequeue WebRTC Signals for an Approved Session Participant
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/sessions/signals'
    ) {
      const body = (await request.json()) as {
        caller: AccountProfile;
        sessionId?: string;
        afterSeq?: number;
      };

      const gate = this.evaluateSignalingGate(
        body.caller.accountId,
        body.sessionId
      );
      if (!gate.allowed) {
        return errorResponse(gate.status, gate.code, gate.message);
      }

      const afterSeq = Number(body.afterSeq ?? 0);
      const rows = sql
        .exec<SessionSignalRow>(
          `SELECT * FROM session_signals
           WHERE session_id = ?
             AND target_account_id = ?
             AND seq > ?
           ORDER BY seq ASC`,
          gate.session.sessionId,
          body.caller.accountId,
          afterSeq
        )
        .toArray();

      const signals: WebRtcSignalEnvelope[] = rows.map((row) => ({
        seq: row.seq,
        signalId: row.signal_id,
        sessionId: row.session_id,
        senderAccountId: row.sender_account_id,
        targetAccountId: row.target_account_id,
        payload: JSON.parse(row.payload_json) as WebRtcSignalPayload,
        createdAt: row.created_at,
      }));

      return Response.json({
        session: gate.session,
        signals,
      });
    }

    return errorResponse(404, 'INVITE_NOT_FOUND', 'Unknown coordinator route.');
  }
}
