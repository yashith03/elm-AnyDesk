import {
  sanitizeHostMediaSelection,
  type AccountProfile,
  type ApprovedSessionSummary,
  type CoordinatorServerEvent,
  type HostMediaSelection,
  type InviteStatus,
  type InviteSummary,
  type PresenceStateSnapshot,
  type ProtocolErrorCode,
  type SessionTerminationReason,
} from '@elm/protocol';

interface InviteRow extends Record<string, SqlStorageValue> {
  invite_id: string;
  requester_account_id: string;
  requester_friend_code: string;
  requester_display_name: string;
  target_account_id: string;
  target_friend_code: string;
  target_display_name: string;
  status: string;
  created_at: string;
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
}

function mapInviteRow(row: InviteRow): InviteSummary {
  return {
    inviteId: row.invite_id,
    requesterAccountId: row.requester_account_id,
    requesterFriendCode: row.requester_friend_code,
    requesterDisplayName: row.requester_display_name,
    targetAccountId: row.target_account_id,
    targetFriendCode: row.target_friend_code,
    targetDisplayName: row.target_display_name,
    status: row.status as InviteStatus,
    createdAt: row.created_at,
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
  private schemaInitialized = false;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
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
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
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
        created_at TEXT NOT NULL
      );
    `);

    this.schemaInitialized = true;
  }

  private isAccountOnline(accountId: string): boolean {
    this.ensureSchema();
    const rows = this.state.storage.sql
      .exec<{ account_id: string }>(
        `SELECT account_id FROM presence_sessions WHERE account_id = ?`,
        accountId
      )
      .toArray();
    return rows.length > 0;
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
    this.ensureSchema();
    return this.state.storage.sql
      .exec<InviteRow>(
        `SELECT * FROM invites
         WHERE target_account_id = ? AND status = 'pending'
         ORDER BY created_at ASC`,
        accountId
      )
      .toArray()
      .map(mapInviteRow);
  }

  private getPendingOutgoingInvite(accountId: string): InviteSummary | null {
    this.ensureSchema();
    const rows = this.state.storage.sql
      .exec<InviteRow>(
        `SELECT * FROM invites
         WHERE requester_account_id = ? AND status = 'pending'
         ORDER BY created_at DESC
         LIMIT 1`,
        accountId
      )
      .toArray();
    return rows.length > 0 ? mapInviteRow(rows[0]) : null;
  }

  private buildPresenceSnapshot(account: AccountProfile): PresenceStateSnapshot {
    this.ensureSchema();
    return {
      online: this.isAccountOnline(account.accountId),
      account,
      incomingInvites: this.getPendingIncomingInvites(account.accountId),
      outgoingInvite: this.getPendingOutgoingInvite(account.accountId),
      activeSession: this.getActiveSessionForAccount(account.accountId),
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
    const now = new Date().toISOString();
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

  private markAccountOffline(
    accountId: string,
    reason: SessionTerminationReason = 'connection_lost'
  ): void {
    this.ensureSchema();
    const sql = this.state.storage.sql;
    const now = new Date().toISOString();

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

    // End any active session involving this account (ended sessions never resume)
    const activeSession = this.getActiveSessionForAccount(accountId);
    if (activeSession) {
      sql.exec(
        `DELETE FROM active_sessions WHERE session_id = ?`,
        activeSession.sessionId
      );
      this.sendEventToAccount(activeSession.hostAccountId, {
        type: 'session:ended',
        sessionId: activeSession.sessionId,
        reason,
      });
      this.sendEventToAccount(activeSession.guestAccountId, {
        type: 'session:ended',
        sessionId: activeSession.sessionId,
        reason,
      });
    }
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
          serverSocket.send(
            JSON.stringify({
              type: 'error',
              code: check.code,
              message: check.message,
            } satisfies CoordinatorServerEvent)
          );
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
  ): { allowed: false; status: number; code: ProtocolErrorCode; message: string } {
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
        allowed: false,
        status: 501,
        code: 'MEDIA_AND_CHAT_DEFERRED_IN_PHASE2',
        message:
          'Session is approved for this participant, but media and chat transport are deferred in Phase 2.',
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
      allowed: false,
      status: 501,
      code: 'MEDIA_AND_CHAT_DEFERRED_IN_PHASE2',
      message:
        'Session is approved, but media and chat transport are deferred in Phase 2.',
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

    // Connect / Heartbeat Presence
    if (request.method === 'POST' && url.pathname === '/internal/presence/connect') {
      const body = (await request.json()) as { account: AccountProfile };
      this.markAccountOnline(body.account);
      return Response.json({
        snapshot: this.buildPresenceSnapshot(body.account),
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
      };
      this.markAccountOffline(
        body.accountId,
        body.reason ?? 'user_top_bar_disconnect'
      );
      return Response.json({ ok: true });
    }

    // Get Presence & Session State Snapshot
    if (request.method === 'POST' && url.pathname === '/internal/presence/state') {
      const body = (await request.json()) as { account: AccountProfile };
      return Response.json({
        snapshot: this.buildPresenceSnapshot(body.account),
      });
    }

    // Create Invite (User B enters User A's Friend Code)
    if (request.method === 'POST' && url.pathname === '/internal/invites/create') {
      const body = (await request.json()) as {
        requester: AccountProfile;
        target: AccountProfile;
      };
      const { requester, target } = body;

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
      const now = new Date().toISOString();

      sql.exec(
        `INSERT INTO invites (
          invite_id,
          requester_account_id,
          requester_friend_code,
          requester_display_name,
          target_account_id,
          target_friend_code,
          target_display_name,
          status,
          created_at,
          resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
        inviteId,
        requester.accountId,
        requester.friendCode,
        requester.displayName,
        target.accountId,
        target.friendCode,
        target.displayName,
        now
      );

      const invite: InviteSummary = {
        inviteId,
        requesterAccountId: requester.accountId,
        requesterFriendCode: requester.friendCode,
        requesterDisplayName: requester.displayName,
        targetAccountId: target.accountId,
        targetFriendCode: target.friendCode,
        targetDisplayName: target.displayName,
        status: 'pending',
        createdAt: now,
        resolvedAt: null,
      };

      // Notify intended owner (User A) in real time
      this.sendEventToAccount(target.accountId, {
        type: 'invite:incoming',
        invite,
      });

      return Response.json({ invite }, { status: 201 });
    }

    // Respond to Invite (User A accepts or declines, choosing the 3 media controls)
    if (request.method === 'POST' && url.pathname === '/internal/invites/respond') {
      const body = (await request.json()) as {
        responder: AccountProfile;
        inviteId: string;
        action: 'accept' | 'decline';
        mediaSelection?: Partial<HostMediaSelection>;
      };

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

      // 1. Accept/Decline ONLY from the intended owner (User A)
      if (body.responder.accountId !== inviteRow.target_account_id) {
        return errorResponse(
          403,
          'NOT_INVITE_OWNER',
          'Only the intended Friend Code owner (User A) can accept or decline this invite.'
        );
      }

      // 2. Simultaneous accepts / already resolved invite check
      if (inviteRow.status !== 'pending') {
        return errorResponse(
          409,
          'INVITE_ALREADY_RESOLVED',
          `Invite has already been ${inviteRow.status}.`
        );
      }

      const now = new Date().toISOString();

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

      // 5. Sanitize User A's independent media consent toggles (both audio options default OFF)
      const mediaSelection = sanitizeHostMediaSelection(body.mediaSelection);
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
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        inviteRow.invite_id,
        inviteRow.target_account_id,
        inviteRow.target_friend_code,
        inviteRow.target_display_name,
        inviteRow.requester_account_id,
        inviteRow.requester_friend_code,
        inviteRow.requester_display_name,
        JSON.stringify(mediaSelection),
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
        hostAccountId: inviteRow.target_account_id,
        hostFriendCode: inviteRow.target_friend_code,
        hostDisplayName: inviteRow.target_display_name,
        guestAccountId: inviteRow.requester_account_id,
        guestFriendCode: inviteRow.requester_friend_code,
        guestDisplayName: inviteRow.requester_display_name,
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
      });
    }

    // Disconnect Active Session (Ends session for both participants; never resumable)
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/sessions/disconnect'
    ) {
      const body = (await request.json()) as {
        caller: AccountProfile;
        sessionId?: string;
      };

      const activeSession = this.getActiveSessionForAccount(
        body.caller.accountId
      );
      if (
        !activeSession ||
        (body.sessionId && activeSession.sessionId !== body.sessionId)
      ) {
        return errorResponse(
          403,
          'UNAUTHORIZED_SESSION_PARTICIPANT',
          'No matching active session found for caller.'
        );
      }

      sql.exec(
        `DELETE FROM active_sessions WHERE session_id = ?`,
        activeSession.sessionId
      );

      this.sendEventToAccount(activeSession.hostAccountId, {
        type: 'session:ended',
        sessionId: activeSession.sessionId,
        reason: 'user_top_bar_disconnect',
      });
      this.sendEventToAccount(activeSession.guestAccountId, {
        type: 'session:ended',
        sessionId: activeSession.sessionId,
        reason: 'user_top_bar_disconnect',
      });

      return Response.json({
        disconnected: true,
        sessionId: activeSession.sessionId,
      });
    }

    // Security Gate Endpoint: Join or Signal Session
    // Verifies:
    // 1. Knowing a Friend Code cannot join an approved session.
    // 2. No signaling is admitted before acceptance.
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/sessions/join-or-signal'
    ) {
      const body = (await request.json()) as {
        caller: AccountProfile;
        sessionId?: string;
        friendCode?: string;
        signalType?: string;
      };

      const gate = this.evaluateSignalingGate(
        body.caller.accountId,
        body.sessionId,
        body.friendCode
      );
      return errorResponse(gate.status, gate.code, gate.message);
    }

    return errorResponse(404, 'INVITE_NOT_FOUND', 'Unknown coordinator route.');
  }
}
