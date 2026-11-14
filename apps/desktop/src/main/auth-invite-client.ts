import { app, safeStorage, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  isValidFriendCode,
  normalizeFriendCode,
  sanitizeHostMediaSelection,
  type AccountProfile,
  type ApprovedSessionSummary,
  type HostMediaSelection,
  type InviteStatus,
  type InviteSummary,
  type PresenceStateSnapshot,
  type ProtocolErrorCode,
  type WebRtcSignalEnvelope,
  type WebRtcSignalPayload,
} from '@elm/protocol';
import type { ApiActionResult } from '../shared/bridge';

interface PersistedDesktopState {
  activeToken: string | null;
  activePersonaKey: string | null;
  tokensByPersona: Record<string, string>;
  d1Accounts: Array<{
    account_id: string;
    provider: string;
    provider_subject: string;
    display_name: string;
    friend_code: string;
    created_at: string;
    updated_at: string;
  }>;
}

interface InMemoryInvite {
  inviteId: string;
  requesterAccountId: string;
  requesterFriendCode: string;
  requesterDisplayName: string;
  targetAccountId: string;
  targetFriendCode: string;
  targetDisplayName: string;
  status: InviteStatus;
  createdAt: string;
  resolvedAt: string | null;
}

const TEST_DOUBLE_PERSONAS: Record<
  string,
  { provider: string; providerSubject: string; displayName: string }
> = {
  alice: {
    provider: 'github',
    providerSubject: 'gh-test-1001',
    displayName: 'Alice (Host A)',
  },
  bob: {
    provider: 'github',
    providerSubject: 'gh-test-1002',
    displayName: 'Bob (Requester B)',
  },
  charlie: {
    provider: 'github',
    providerSubject: 'gh-test-1003',
    displayName: 'Charlie (Peer C)',
  },
};

export class DesktopAuthAndInviteController {
  public readonly apiBaseUrl: string;
  private readonly stateFilePath: string;
  private persisted: PersistedDesktopState;

  // Coordinator state for local test-double evaluation when Worker/OAuth secrets are unavailable
  private readonly onlineAccounts = new Set<string>();
  private readonly invites = new Map<string, InMemoryInvite>();
  private readonly activeSessions = new Map<string, ApprovedSessionSummary>();
  private readonly sessionSignals = new Map<string, WebRtcSignalEnvelope[]>();
  private signalSequence = 0;
  private readonly tokenToAccountId = new Map<string, string>();

  constructor(apiBaseUrl?: string) {
    this.apiBaseUrl =
      apiBaseUrl ||
      process.env.ELM_API_BASE_URL ||
      'http://127.0.0.1:8787';
    this.stateFilePath = path.join(
      app.getPath('userData'),
      'elm-phase2-auth-state.json'
    );
    this.persisted = this.loadPersistedState();
    this.rebuildTokenIndex();
  }

  private loadPersistedState(): PersistedDesktopState {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedDesktopState> & {
          encryptedActiveTokenBase64?: string;
        };

        let activeToken = parsed.activeToken ?? null;
        if (
          !activeToken &&
          parsed.encryptedActiveTokenBase64 &&
          safeStorage.isEncryptionAvailable()
        ) {
          activeToken = safeStorage.decryptString(
            Buffer.from(parsed.encryptedActiveTokenBase64, 'base64')
          );
        }

        return {
          activeToken,
          activePersonaKey: parsed.activePersonaKey ?? null,
          tokensByPersona: parsed.tokensByPersona ?? {},
          d1Accounts: Array.isArray(parsed.d1Accounts)
            ? parsed.d1Accounts
            : [],
        };
      }
    } catch {
      // Ignore corrupt local state
    }

    return {
      activeToken: null,
      activePersonaKey: null,
      tokensByPersona: {},
      d1Accounts: [],
    };
  }

  private savePersistedState(): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      fs.mkdirSync(dir, { recursive: true });

      const payloadToSave: Record<string, unknown> = {
        activePersonaKey: this.persisted.activePersonaKey,
        tokensByPersona: this.persisted.tokensByPersona,
        d1Accounts: this.persisted.d1Accounts,
      };

      if (
        this.persisted.activeToken &&
        safeStorage.isEncryptionAvailable()
      ) {
        payloadToSave.encryptedActiveTokenBase64 = safeStorage
          .encryptString(this.persisted.activeToken)
          .toString('base64');
      } else {
        payloadToSave.activeToken = this.persisted.activeToken;
      }

      fs.writeFileSync(
        this.stateFilePath,
        JSON.stringify(payloadToSave, null, 2),
        'utf8'
      );
    } catch {
      // Ignore write errors
    }
  }

  private rebuildTokenIndex(): void {
    for (const [persona, token] of Object.entries(
      this.persisted.tokensByPersona
    )) {
      const identity = TEST_DOUBLE_PERSONAS[persona];
      if (!identity) continue;
      const acct = this.persisted.d1Accounts.find(
        (a) =>
          a.provider === identity.provider &&
          a.provider_subject === identity.providerSubject
      );
      if (acct) {
        this.tokenToAccountId.set(token, acct.account_id);
      }
    }
  }

  private mapAccountRow(
    row: PersistedDesktopState['d1Accounts'][number]
  ): AccountProfile {
    return {
      accountId: row.account_id,
      provider: row.provider,
      providerSubject: row.provider_subject,
      displayName: row.display_name,
      friendCode: row.friend_code,
      createdAt: row.created_at,
    };
  }

  private getCurrentAccount(): AccountProfile | null {
    const token = this.persisted.activeToken;
    if (!token) return null;
    const accountId = this.tokenToAccountId.get(token);
    if (!accountId) return null;
    const row = this.persisted.d1Accounts.find(
      (a) => a.account_id === accountId
    );
    return row ? this.mapAccountRow(row) : null;
  }

  private getActiveSessionForAccount(
    accountId: string
  ): ApprovedSessionSummary | null {
    for (const session of this.activeSessions.values()) {
      if (
        session.hostAccountId === accountId ||
        session.guestAccountId === accountId
      ) {
        return session;
      }
    }
    return null;
  }

  private buildSnapshot(account: AccountProfile): PresenceStateSnapshot {
    const incomingInvites: InviteSummary[] = [];
    let outgoingInvite: InviteSummary | null = null;

    for (const inv of this.invites.values()) {
      if (
        inv.targetAccountId === account.accountId &&
        inv.status === 'pending'
      ) {
        incomingInvites.push({ ...inv });
      }
      if (
        inv.requesterAccountId === account.accountId &&
        inv.status === 'pending'
      ) {
        outgoingInvite = { ...inv };
      }
    }

    return {
      online: this.onlineAccounts.has(account.accountId),
      account,
      incomingInvites,
      outgoingInvite,
      activeSession: this.getActiveSessionForAccount(account.accountId),
    };
  }

  /**
   * Starts the real desktop-safe browser OAuth 2.0 flow:
   * 1. Probes Worker `/auth/login` first to verify Worker reachability & OAuth credentials.
   * 2. Binds a loopback HTTP callback listener on `127.0.0.1:0` and launches the system browser.
   */
  public async startBrowserOAuthSignIn(): Promise<
    ApiActionResult<{ authUrlOpened: boolean; message: string }>
  > {
    try {
      const probeUrl = `${this.apiBaseUrl}/auth/login?redirect_uri=${encodeURIComponent(
        'http://127.0.0.1:45821/auth/callback'
      )}&desktop_state=probe`;

      const probeRes = await fetch(probeUrl, { redirect: 'manual' });
      if (probeRes.status === 503) {
        const body = (await probeRes.json().catch(() => ({}))) as {
          error?: ProtocolErrorCode;
          message?: string;
        };
        return {
          ok: false,
          status: 503,
          errorCode: body.error || 'AUTH_PROVIDER_NOT_CONFIGURED',
          errorMessage:
            body.message ||
            'Worker OAuth provider credentials (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET) are not configured in apps/api/.dev.vars. Use the Isolated Test Double Adapter below to test locally without secrets.',
        };
      }

      if (probeRes.status !== 302) {
        return {
          ok: false,
          status: probeRes.status,
          errorCode: 'AUTH_PROVIDER_NOT_CONFIGURED',
          errorMessage: `Unexpected response from Worker /auth/login (HTTP ${probeRes.status}).`,
        };
      }
    } catch {
      return {
        ok: false,
        status: 503,
        errorCode: 'AUTH_PROVIDER_NOT_CONFIGURED',
        errorMessage: `Local Cloudflare Worker (${this.apiBaseUrl}) is not running or OAuth secrets are not configured. Run "npm run dev:api" with apps/api/.dev.vars configured, or use the Isolated Test Double Adapter below.`,
      };
    }

    // Worker is reachable and configured with OAuth credentials: start loopback server & open browser
    return new Promise((resolve) => {
      const desktopState = crypto.randomUUID();
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
          if (reqUrl.pathname !== '/auth/callback') {
            res.writeHead(404);
            res.end('Not found');
            return;
          }

          const token = reqUrl.searchParams.get('token') || '';
          const returnedState = reqUrl.searchParams.get('state') || '';
          if (!token || returnedState !== desktopState) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h3>Invalid OAuth callback state.</h3>');
            return;
          }

          const meRes = await fetch(`${this.apiBaseUrl}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (meRes.ok) {
            const meData = (await meRes.json()) as { account: AccountProfile };
            const existingIdx = this.persisted.d1Accounts.findIndex(
              (a) => a.account_id === meData.account.accountId
            );
            const row = {
              account_id: meData.account.accountId,
              provider: meData.account.provider,
              provider_subject: meData.account.providerSubject,
              display_name: meData.account.displayName,
              friend_code: meData.account.friendCode,
              created_at: meData.account.createdAt,
              updated_at: new Date().toISOString(),
            };
            if (existingIdx >= 0) {
              this.persisted.d1Accounts[existingIdx] = row;
            } else {
              this.persisted.d1Accounts.push(row);
            }
            this.persisted.activeToken = token;
            this.tokenToAccountId.set(token, meData.account.accountId);
            this.onlineAccounts.add(meData.account.accountId);
            this.savePersistedState();
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<html><body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:32px;"><h2>Elm-AnyDesk Sign-In Complete</h2><p>You can close this browser tab and return to the Elm-AnyDesk desktop app.</p></body></html>'
          );
        } finally {
          server.close();
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 45821;
        const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
        const loginUrl = `${
          this.apiBaseUrl
        }/auth/login?redirect_uri=${encodeURIComponent(
          redirectUri
        )}&desktop_state=${encodeURIComponent(desktopState)}`;

        void shell.openExternal(loginUrl);
        resolve({
          ok: true,
          status: 200,
          data: {
            authUrlOpened: true,
            message: `Opened system browser for GitHub OAuth sign-in (loopback callback on 127.0.0.1:${port}).`,
          },
        });
      });
    });
  }

  /**
   * Isolated Test Double sign-in when external OAuth credentials are unavailable locally.
   * Creates the account and permanent Friend Code once in persisted D1 storage and reuses
   * the exact same Friend Code across restarts and repeated sign-ins.
   */
  public signInWithTestDouble(
    personaKey: string
  ): ApiActionResult<{ account: AccountProfile; snapshot: PresenceStateSnapshot }> {
    const key = personaKey.trim().toLowerCase();
    const identity = TEST_DOUBLE_PERSONAS[key];
    if (!identity) {
      return {
        ok: false,
        status: 400,
        errorCode: 'UNAUTHORIZED',
        errorMessage: `Unknown test-double persona "${personaKey}". Expected alice, bob, or charlie.`,
      };
    }

    const now = new Date().toISOString();
    let existing = this.persisted.d1Accounts.find(
      (a) =>
        a.provider === identity.provider &&
        a.provider_subject === identity.providerSubject
    );

    if (!existing) {
      // Create unique random Friend Code once and persist it
      let candidateCode = '';
      for (let i = 0; i < 20; i++) {
        const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
        const bytes = crypto.randomBytes(8);
        let p1 = '';
        let p2 = '';
        for (let j = 0; j < 4; j++) {
          p1 += alphabet[bytes[j] % alphabet.length];
          p2 += alphabet[bytes[j + 4] % alphabet.length];
        }
        candidateCode = `ELM-${p1}-${p2}`;
        if (
          !this.persisted.d1Accounts.some(
            (a) => a.friend_code === candidateCode
          )
        ) {
          break;
        }
      }

      existing = {
        account_id: crypto.randomUUID(),
        provider: identity.provider,
        provider_subject: identity.providerSubject,
        display_name: identity.displayName,
        friend_code: candidateCode,
        created_at: now,
        updated_at: now,
      };
      this.persisted.d1Accounts.push(existing);
    } else {
      // Reuse existing account_id and permanent friend_code across restarts & sign-ins
      existing.display_name = identity.displayName;
      existing.updated_at = now;
    }

    let token = this.persisted.tokensByPersona[key];
    if (!token) {
      token = `td_session_${key}_${crypto.randomBytes(12).toString('hex')}`;
      this.persisted.tokensByPersona[key] = token;
    }

    this.tokenToAccountId.set(token, existing.account_id);
    this.persisted.activePersonaKey = key;
    this.persisted.activeToken = token;
    this.onlineAccounts.add(existing.account_id);
    this.savePersistedState();

    const profile = this.mapAccountRow(existing);
    return {
      ok: true,
      status: 200,
      data: {
        account: profile,
        snapshot: this.buildSnapshot(profile),
      },
    };
  }

  public switchActivePersona(
    personaKey: string
  ): ApiActionResult<{ account: AccountProfile; snapshot: PresenceStateSnapshot }> {
    return this.signInWithTestDouble(personaKey);
  }

  public getStoredAuthSession(): ApiActionResult<{
    account: AccountProfile;
    snapshot: PresenceStateSnapshot;
  }> {
    const account = this.getCurrentAccount();
    if (!account) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    this.onlineAccounts.add(account.accountId);
    return {
      ok: true,
      status: 200,
      data: {
        account,
        snapshot: this.buildSnapshot(account),
      },
    };
  }

  public signOut(): { signedOut: boolean } {
    const current = this.getCurrentAccount();
    if (current) {
      this.setAccountOfflineInternal(current.accountId);
    }
    this.persisted.activeToken = null;
    this.persisted.activePersonaKey = null;
    this.savePersistedState();
    return { signedOut: true };
  }

  private setAccountOfflineInternal(accountId: string): void {
    this.onlineAccounts.delete(accountId);
    const now = new Date().toISOString();

    for (const inv of this.invites.values()) {
      if (
        (inv.requesterAccountId === accountId ||
          inv.targetAccountId === accountId) &&
        inv.status === 'pending'
      ) {
        inv.status = 'cancelled';
        inv.resolvedAt = now;
      }
    }

    const active = this.getActiveSessionForAccount(accountId);
    if (active) {
      this.activeSessions.delete(active.sessionId);
      this.sessionSignals.delete(active.sessionId);
    }
  }

  public getPresenceSnapshot(): ApiActionResult<{
    snapshot: PresenceStateSnapshot;
  }> {
    const account = this.getCurrentAccount();
    if (!account) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }
    return {
      ok: true,
      status: 200,
      data: {
        snapshot: this.buildSnapshot(account),
      },
    };
  }

  public setPresenceOnline(
    online: boolean
  ): ApiActionResult<{ snapshot: PresenceStateSnapshot }> {
    const account = this.getCurrentAccount();
    if (!account) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    if (online) {
      this.onlineAccounts.add(account.accountId);
    } else {
      this.setAccountOfflineInternal(account.accountId);
    }

    return {
      ok: true,
      status: 200,
      data: {
        snapshot: this.buildSnapshot(account),
      },
    };
  }

  public sendFriendCodeInvite(
    rawFriendCode: string
  ): ApiActionResult<{ invite: InviteSummary; snapshot: PresenceStateSnapshot }> {
    const requester = this.getCurrentAccount();
    if (!requester) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'You must sign in before sending an invite.',
      };
    }

    const normalized = normalizeFriendCode(rawFriendCode);
    if (!isValidFriendCode(normalized)) {
      return {
        ok: false,
        status: 400,
        errorCode: 'INVALID_FRIEND_CODE_FORMAT',
        errorMessage:
          'Invalid Friend Code format. Expected ELM-XXXX-XXXX using valid uppercase alphanumeric characters.',
      };
    }

    if (normalized === requester.friendCode) {
      return {
        ok: false,
        status: 400,
        errorCode: 'SELF_INVITE_NOT_ALLOWED',
        errorMessage: 'You cannot send an invite to your own Friend Code.',
      };
    }

    const targetRow = this.persisted.d1Accounts.find(
      (a) => a.friend_code === normalized
    );
    if (!targetRow) {
      return {
        ok: false,
        status: 404,
        errorCode: 'FRIEND_CODE_NOT_FOUND',
        errorMessage: 'No account exists with that Friend Code.',
      };
    }

    const target = this.mapAccountRow(targetRow);

    if (this.getActiveSessionForAccount(requester.accountId)) {
      return {
        ok: false,
        status: 409,
        errorCode: 'USER_ALREADY_IN_ACTIVE_SESSION',
        errorMessage:
          'You are already in an active 1:1 session. Disconnect first.',
      };
    }

    if (this.getActiveSessionForAccount(target.accountId)) {
      return {
        ok: false,
        status: 409,
        errorCode: 'USER_ALREADY_IN_ACTIVE_SESSION',
        errorMessage:
          'The owner of this Friend Code is already in another active 1:1 session.',
      };
    }

    if (!this.onlineAccounts.has(target.accountId)) {
      return {
        ok: false,
        status: 409,
        errorCode: 'TARGET_OFFLINE',
        errorMessage: 'The owner of this Friend Code is currently offline.',
      };
    }

    for (const inv of this.invites.values()) {
      if (
        inv.requesterAccountId === requester.accountId &&
        inv.targetAccountId === target.accountId &&
        inv.status === 'pending'
      ) {
        return {
          ok: false,
          status: 409,
          errorCode: 'DUPLICATE_PENDING_INVITE',
          errorMessage:
            'An invite to this Friend Code is already pending response.',
        };
      }
      if (
        inv.requesterAccountId === requester.accountId &&
        inv.status === 'pending'
      ) {
        return {
          ok: false,
          status: 409,
          errorCode: 'OUTGOING_INVITE_ALREADY_PENDING',
          errorMessage:
            'You already have a pending outgoing invite to another user.',
        };
      }
    }

    const invite: InMemoryInvite = {
      inviteId: crypto.randomUUID(),
      requesterAccountId: requester.accountId,
      requesterFriendCode: requester.friendCode,
      requesterDisplayName: requester.displayName,
      targetAccountId: target.accountId,
      targetFriendCode: target.friendCode,
      targetDisplayName: target.displayName,
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };

    this.invites.set(invite.inviteId, invite);

    return {
      ok: true,
      status: 201,
      data: {
        invite: { ...invite },
        snapshot: this.buildSnapshot(requester),
      },
    };
  }

  public respondToInvite(params: {
    inviteId: string;
    action: 'accept' | 'decline';
    mediaSelection?: HostMediaSelection;
  }): ApiActionResult<{
    invite: InviteSummary;
    session: ApprovedSessionSummary | null;
    snapshot: PresenceStateSnapshot;
  }> {
    const responder = this.getCurrentAccount();
    if (!responder) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    const invite = this.invites.get(params.inviteId);
    if (!invite) {
      return {
        ok: false,
        status: 404,
        errorCode: 'INVITE_NOT_FOUND',
        errorMessage: 'Invite not found.',
      };
    }

    if (invite.targetAccountId !== responder.accountId) {
      return {
        ok: false,
        status: 403,
        errorCode: 'NOT_INVITE_OWNER',
        errorMessage:
          'Only the intended Friend Code owner can accept or decline this invite.',
      };
    }

    if (invite.status !== 'pending') {
      return {
        ok: false,
        status: 409,
        errorCode: 'INVITE_ALREADY_RESOLVED',
        errorMessage: `Invite has already been ${invite.status}.`,
      };
    }

    const now = new Date().toISOString();

    if (params.action === 'decline') {
      invite.status = 'declined';
      invite.resolvedAt = now;
      return {
        ok: true,
        status: 200,
        data: {
          invite: { ...invite },
          session: null,
          snapshot: this.buildSnapshot(responder),
        },
      };
    }

    // action === 'accept'
    if (
      this.getActiveSessionForAccount(invite.targetAccountId) ||
      this.getActiveSessionForAccount(invite.requesterAccountId)
    ) {
      return {
        ok: false,
        status: 409,
        errorCode: 'USER_ALREADY_IN_ACTIVE_SESSION',
        errorMessage:
          'One of the users is already in an active 1:1 session.',
      };
    }

    if (!this.onlineAccounts.has(invite.requesterAccountId)) {
      invite.status = 'cancelled';
      invite.resolvedAt = now;
      return {
        ok: false,
        status: 409,
        errorCode: 'TARGET_OFFLINE',
        errorMessage: 'Requester went offline before acceptance.',
      };
    }

    const mediaSelection = sanitizeHostMediaSelection(params.mediaSelection);
    invite.status = 'accepted';
    invite.resolvedAt = now;

    // Cancel any other pending invites involving either participant
    for (const other of this.invites.values()) {
      if (
        other.inviteId !== invite.inviteId &&
        other.status === 'pending' &&
        (other.targetAccountId === invite.targetAccountId ||
          other.requesterAccountId === invite.targetAccountId ||
          other.targetAccountId === invite.requesterAccountId ||
          other.requesterAccountId === invite.requesterAccountId)
      ) {
        other.status = 'cancelled';
        other.resolvedAt = now;
      }
    }

    const approvedSession: ApprovedSessionSummary = {
      sessionId: crypto.randomUUID(),
      inviteId: invite.inviteId,
      hostAccountId: invite.targetAccountId,
      hostFriendCode: invite.targetFriendCode,
      hostDisplayName: invite.targetDisplayName,
      guestAccountId: invite.requesterAccountId,
      guestFriendCode: invite.requesterFriendCode,
      guestDisplayName: invite.requesterDisplayName,
      hostMediaSelection: mediaSelection,
      createdAt: now,
    };

    this.activeSessions.set(approvedSession.sessionId, approvedSession);

    return {
      ok: true,
      status: 200,
      data: {
        invite: { ...invite },
        session: approvedSession,
        snapshot: this.buildSnapshot(responder),
      },
    };
  }

  public disconnectActiveSession(
    sessionId?: string
  ): ApiActionResult<{ disconnected: boolean; snapshot: PresenceStateSnapshot }> {
    const caller = this.getCurrentAccount();
    if (!caller) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    const active = this.getActiveSessionForAccount(caller.accountId);
    if (!active || (sessionId && active.sessionId !== sessionId)) {
      return {
        ok: false,
        status: 403,
        errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
        errorMessage: 'No active session found for caller.',
      };
    }

    this.activeSessions.delete(active.sessionId);
    this.sessionSignals.delete(active.sessionId);

    return {
      ok: true,
      status: 200,
      data: {
        disconnected: true,
        snapshot: this.buildSnapshot(caller),
      },
    };
  }

  public sendSessionSignal(params: {
    sessionId: string;
    senderAccountId?: string;
    payload: WebRtcSignalPayload;
  }): ApiActionResult<{
    admitted: boolean;
    session: ApprovedSessionSummary;
    envelope: WebRtcSignalEnvelope;
  }> {
    const current = this.getCurrentAccount();
    const senderId = params.senderAccountId || current?.accountId;
    if (!senderId) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    const session = this.activeSessions.get(params.sessionId);
    if (!session) {
      return {
        ok: false,
        status: 403,
        errorCode: 'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE',
        errorMessage:
          'No signaling is admitted before an invite is explicitly accepted by the intended owner.',
      };
    }

    if (
      session.hostAccountId !== senderId &&
      session.guestAccountId !== senderId
    ) {
      return {
        ok: false,
        status: 403,
        errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
        errorMessage:
          'Caller is not an approved participant of this 1:1 session. Knowing a Friend Code cannot join an approved session.',
      };
    }

    const pType = params.payload?.type;
    if (
      pType !== 'offer' &&
      pType !== 'answer' &&
      pType !== 'ice-candidate' &&
      pType !== 'media-status'
    ) {
      return {
        ok: false,
        status: 400,
        errorCode: 'INVALID_SIGNAL_PAYLOAD',
        errorMessage:
          'Coordinator only accepts WebRTC signaling payloads (offer, answer, ice-candidate, media-status), never media frames or chat payloads.',
      };
    }

    const targetAccountId =
      senderId === session.hostAccountId
        ? session.guestAccountId
        : session.hostAccountId;

    this.signalSequence += 1;
    const envelope: WebRtcSignalEnvelope = {
      seq: this.signalSequence,
      signalId: crypto.randomUUID(),
      sessionId: session.sessionId,
      senderAccountId: senderId,
      targetAccountId,
      payload: params.payload,
      createdAt: new Date().toISOString(),
    };

    let list = this.sessionSignals.get(session.sessionId);
    if (!list) {
      list = [];
      this.sessionSignals.set(session.sessionId, list);
    }
    list.push(envelope);

    return {
      ok: true,
      status: 200,
      data: {
        admitted: true,
        session,
        envelope,
      },
    };
  }

  public pollSessionSignals(params: {
    sessionId: string;
    receiverAccountId?: string;
    afterSeq: number;
  }): ApiActionResult<{
    session: ApprovedSessionSummary;
    signals: readonly WebRtcSignalEnvelope[];
  }> {
    const current = this.getCurrentAccount();
    const receiverId = params.receiverAccountId || current?.accountId;
    if (!receiverId) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    const session = this.activeSessions.get(params.sessionId);
    if (!session) {
      return {
        ok: false,
        status: 403,
        errorCode: 'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE',
        errorMessage:
          'No signaling is admitted before an invite is explicitly accepted.',
      };
    }

    if (
      session.hostAccountId !== receiverId &&
      session.guestAccountId !== receiverId
    ) {
      return {
        ok: false,
        status: 403,
        errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
        errorMessage:
          'Caller is not an approved participant of this 1:1 session.',
      };
    }

    const list = this.sessionSignals.get(session.sessionId) ?? [];
    const signals = list.filter(
      (s) => s.targetAccountId === receiverId && s.seq > params.afterSeq
    );

    return {
      ok: true,
      status: 200,
      data: {
        session,
        signals,
      },
    };
  }
}
