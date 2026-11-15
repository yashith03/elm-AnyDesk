import { app, safeStorage, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LIVENESS_CONFIG,
  isValidFriendCode,
  normalizeFriendCode,
  sanitizeHostMediaSelection,
  type AccountProfile,
  type AnonymousDeviceRegistrationResponse,
  type ApprovedSessionSummary,
  type DeviceRegistrationStatus,
  type HostMediaSelection,
  type InviteStatus,
  type InviteSummary,
  type LocalDeviceProfile,
  type PresenceStateSnapshot,
  type ProtocolErrorCode,
  type SessionTeardownReceipt,
  type SessionTerminationReason,
  type WebRtcSignalEnvelope,
  type WebRtcSignalPayload,
} from '@elm/protocol';
import type { ApiActionResult, DeviceSetupState } from '../shared/bridge';

interface PersistedDesktopState {
  activeToken: string | null;
  activePersonaKey: string | null;
  tokensByPersona: Record<string, string>;
  localProfile: LocalDeviceProfile | null;
  deviceCredential: {
    deviceId: string;
    deviceSecret: string;
  } | null;
  registeredAccount: AccountProfile | null;
  registeredToken: string | null;
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

declare const __ELM_DEFAULT_API_BASE_URL__: string | undefined;

export class DesktopAuthAndInviteController {
  public readonly apiBaseUrl: string;
  private readonly stateFilePath: string;
  private persisted: PersistedDesktopState;

  // Coordinator state for local test-double evaluation when Worker/OAuth secrets are unavailable
  private readonly onlineAccounts = new Set<string>();
  private readonly invites = new Map<string, InMemoryInvite>();
  private readonly activeSessions = new Map<string, ApprovedSessionSummary>();
  private readonly terminatedSessions = new Map<
    string,
    {
      session: ApprovedSessionSummary;
      receipt: SessionTeardownReceipt;
    }
  >();
  private readonly sessionHeartbeats = new Map<
    string,
    {
      lastHostHeartbeatMs: number;
      lastGuestHeartbeatMs: number;
    }
  >();
  private readonly sessionSignals = new Map<string, WebRtcSignalEnvelope[]>();
  private signalSequence = 0;
  private readonly tokenToAccountId = new Map<string, string>();
  private registrationStatus: DeviceRegistrationStatus = 'unregistered';
  private registrationMessage: string | null = null;

  constructor(apiBaseUrl?: string) {
    const buildTimeDefaultApiBaseUrl =
      typeof __ELM_DEFAULT_API_BASE_URL__ === 'string' &&
      __ELM_DEFAULT_API_BASE_URL__.trim().length > 0
        ? __ELM_DEFAULT_API_BASE_URL__.trim()
        : '';
    this.apiBaseUrl =
      apiBaseUrl ||
      process.env.ELM_API_BASE_URL ||
      buildTimeDefaultApiBaseUrl ||
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
          localProfile: parsed.localProfile ?? null,
          deviceCredential: parsed.deviceCredential ?? null,
          registeredAccount: parsed.registeredAccount ?? null,
          registeredToken: parsed.registeredToken ?? null,
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
      localProfile: null,
      deviceCredential: null,
      registeredAccount: null,
      registeredToken: null,
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
        localProfile: this.persisted.localProfile,
        deviceCredential: this.persisted.deviceCredential,
        registeredAccount: this.persisted.registeredAccount,
        registeredToken: this.persisted.registeredToken,
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
    if (this.persisted.registeredAccount && this.persisted.registeredToken) {
      this.tokenToAccountId.set(
        this.persisted.registeredToken,
        this.persisted.registeredAccount.accountId
      );
      this.registrationStatus = 'registered';
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

  private ensureDeviceCredential(): { deviceId: string; deviceSecret: string } {
    if (!this.persisted.deviceCredential) {
      this.persisted.deviceCredential = {
        deviceId: crypto.randomUUID(),
        deviceSecret: crypto.randomBytes(32).toString('hex'),
      };
      this.savePersistedState();
    }
    return this.persisted.deviceCredential;
  }

  private isRemoteDeviceMode(): boolean {
    return (
      Boolean(this.persisted.registeredAccount) &&
      this.persisted.activePersonaKey === null
    );
  }

  private async fetchRemoteApi<T>(
    pathname: string,
    init?: RequestInit,
    retriedAuth = false
  ): Promise<ApiActionResult<T>> {
    if (!this.persisted.registeredToken) {
      await this.registerDeviceWithBackend();
    }
    const token = this.persisted.registeredToken;
    if (!token) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage:
          this.registrationMessage ||
          'Device is not registered with the Elm registry.',
      };
    }

    try {
      const response = await fetch(`${this.apiBaseUrl}${pathname}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      });

      if (response.status === 401 && !retriedAuth) {
        await this.registerDeviceWithBackend();
        if (this.persisted.registeredToken) {
          return this.fetchRemoteApi<T>(pathname, init, true);
        }
      }

      const payload = (await response.json().catch(() => ({}))) as T & {
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          errorCode: payload.error ?? `HTTP_${response.status}`,
          errorMessage:
            payload.message ??
            `Request failed with status ${response.status}.`,
        };
      }

      return {
        ok: true,
        status: response.status,
        data: payload,
      };
    } catch {
      return {
        ok: false,
        status: 503,
        errorCode: 'NETWORK_ERROR',
        errorMessage:
          'Could not reach the Elm signaling server. Check your internet connection.',
      };
    }
  }

  private buildDeviceSetupState(): DeviceSetupState {
    return {
      profileCompleted: Boolean(this.persisted.localProfile?.name),
      localProfile: this.persisted.localProfile,
      registrationStatus: this.registrationStatus,
      registrationMessage: this.registrationMessage,
      registeredAccount: this.persisted.registeredAccount,
    };
  }

  private async registerDeviceWithBackend(): Promise<DeviceSetupState> {
    const credential = this.ensureDeviceCredential();
    this.registrationStatus = 'registering';
    this.registrationMessage = 'Registering device with Elm registry...';

    try {
      const response = await fetch(`${this.apiBaseUrl}/devices/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: credential.deviceId,
          deviceSecret: credential.deviceSecret,
        }),
      });

      if (!response.ok) {
        const errPayload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        this.registrationStatus = response.status >= 500 ? 'offline' : 'error';
        this.registrationMessage =
          errPayload.message ||
          `Device registration failed (HTTP ${response.status}). Check your connection and retry.`;
        return this.buildDeviceSetupState();
      }

      const payload =
        (await response.json()) as AnonymousDeviceRegistrationResponse;
      const localDisplayName =
        this.persisted.localProfile?.name ||
        payload.account.displayName ||
        os.hostname() ||
        'Elm Device';

      const accountWithLocalDisplay: AccountProfile = {
        ...payload.account,
        displayName: localDisplayName,
      };

      this.persisted.registeredAccount = accountWithLocalDisplay;
      this.persisted.registeredToken = payload.token;
      this.persisted.activeToken = payload.token;
      this.persisted.activePersonaKey = null;

      const existingIdx = this.persisted.d1Accounts.findIndex(
        (a) => a.account_id === accountWithLocalDisplay.accountId
      );
      const row = {
        account_id: accountWithLocalDisplay.accountId,
        provider: accountWithLocalDisplay.provider,
        provider_subject: accountWithLocalDisplay.providerSubject,
        display_name: localDisplayName,
        friend_code: accountWithLocalDisplay.friendCode,
        created_at: accountWithLocalDisplay.createdAt,
        updated_at: new Date().toISOString(),
      };
      if (existingIdx >= 0) {
        this.persisted.d1Accounts[existingIdx] = row;
      } else {
        this.persisted.d1Accounts.push(row);
      }

      this.tokenToAccountId.set(
        payload.token,
        accountWithLocalDisplay.accountId
      );
      this.onlineAccounts.add(accountWithLocalDisplay.accountId);
      this.registrationStatus = 'registered';
      this.registrationMessage = null;
      this.savePersistedState();

      return this.buildDeviceSetupState();
    } catch {
      this.registrationStatus = 'offline';
      this.registrationMessage =
        'Offline before registration: could not reach the Elm registry to assign a device code. Check your connection and click Retry.';
      return this.buildDeviceSetupState();
    }
  }

  public async getDeviceSetupState(): Promise<ApiActionResult<DeviceSetupState>> {
    if (
      this.persisted.localProfile?.name &&
      !this.persisted.registeredAccount
    ) {
      await this.registerDeviceWithBackend();
    } else if (this.persisted.registeredAccount) {
      this.registrationStatus = 'registered';
      this.registrationMessage = null;
      this.onlineAccounts.add(this.persisted.registeredAccount.accountId);
      if (this.isRemoteDeviceMode()) {
        void this.fetchRemoteApi<{ snapshot: PresenceStateSnapshot }>(
          '/presence/connect',
          { method: 'POST', body: '{}' }
        );
      }
    }

    return {
      ok: true,
      status: 200,
      data: this.buildDeviceSetupState(),
    };
  }

  public async saveLocalProfile(input: {
    name: string;
    email?: string;
    phone?: string;
  }): Promise<ApiActionResult<DeviceSetupState>> {
    const cleanedName = String(input.name ?? '').trim().slice(0, 60);
    if (!cleanedName) {
      return {
        ok: false,
        status: 400,
        errorCode: 'INVALID_REQUEST',
        errorMessage: 'Name is required to set up this device.',
      };
    }

    this.persisted.localProfile = {
      name: cleanedName,
      email: String(input.email ?? '').trim().slice(0, 120),
      phone: String(input.phone ?? '').trim().slice(0, 40),
      updatedAt: new Date().toISOString(),
    };

    if (this.persisted.registeredAccount) {
      this.persisted.registeredAccount = {
        ...this.persisted.registeredAccount,
        displayName: cleanedName,
      };
      const row = this.persisted.d1Accounts.find(
        (a) => a.account_id === this.persisted.registeredAccount?.accountId
      );
      if (row) {
        row.display_name = cleanedName;
        row.updated_at = new Date().toISOString();
      }
    }

    this.savePersistedState();

    if (!this.persisted.registeredAccount) {
      await this.registerDeviceWithBackend();
    }

    return {
      ok: true,
      status: 200,
      data: this.buildDeviceSetupState(),
    };
  }

  public async retryDeviceRegistration(): Promise<
    ApiActionResult<DeviceSetupState>
  > {
    const state = await this.registerDeviceWithBackend();
    return {
      ok: true,
      status: 200,
      data: state,
    };
  }

  public updateLocalDisplayName(displayName: string): ApiActionResult<{
    account: AccountProfile;
    snapshot: PresenceStateSnapshot;
  }> {
    const current = this.getCurrentAccount();
    if (!current) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Device is not registered yet.',
      };
    }
    const cleaned = displayName.trim().slice(0, 60) || current.displayName;
    if (this.persisted.localProfile) {
      this.persisted.localProfile = {
        ...this.persisted.localProfile,
        name: cleaned,
        updatedAt: new Date().toISOString(),
      };
    }
    if (this.persisted.registeredAccount) {
      this.persisted.registeredAccount = {
        ...this.persisted.registeredAccount,
        displayName: cleaned,
      };
    }
    const row = this.persisted.d1Accounts.find(
      (a) => a.account_id === current.accountId
    );
    if (row) {
      row.display_name = cleaned;
      row.updated_at = new Date().toISOString();
    }
    this.savePersistedState();
    const updated = row
      ? this.mapAccountRow(row)
      : { ...current, displayName: cleaned };
    return {
      ok: true,
      status: 200,
      data: {
        account: updated,
        snapshot: this.buildSnapshot(updated),
      },
    };
  }

  public getStoredAuthSession(): ApiActionResult<{
    account: AccountProfile;
    snapshot: PresenceStateSnapshot;
  }> {
    const account = this.getCurrentAccount();
    if (!account) {
      return {
        ok: false,
        status: 404,
        errorCode: 'UNAUTHORIZED',
        errorMessage:
          this.registrationMessage ?? 'Device has not been registered yet.',
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

  private getAccountByPersona(personaKey: string): AccountProfile | null {
    const identity = TEST_DOUBLE_PERSONAS[personaKey.trim().toLowerCase()];
    if (!identity) return null;
    const row = this.persisted.d1Accounts.find(
      (a) =>
        a.provider === identity.provider &&
        a.provider_subject === identity.providerSubject
    );
    return row ? this.mapAccountRow(row) : null;
  }

  /**
   * Unified idempotent session teardown path on the desktop coordinator.
   * Called by:
   * - Top-bar Disconnect (Host A or Guest B)
   * - App close / quit (Host A or Guest B)
   * - Detected connection loss / liveness timeout / sleep
   * Ensures ended sessions are tombstoned in `terminatedSessions` so stale events
   * are rejected with `SESSION_ALREADY_ENDED` and duplicate teardown calls return
   * `alreadyEnded: true` idempotently.
   */
  public teardownSessionIdempotent(params: {
    sessionId?: string;
    callerAccountId?: string;
    reason?: SessionTerminationReason;
    subReason?: string;
    detectionTimeMs?: number;
  }):
    | {
        ok: true;
        status: 200;
        disconnected: true;
        alreadyEnded: boolean;
        receipt: SessionTeardownReceipt;
      }
    | {
        ok: false;
        status: number;
        errorCode: ProtocolErrorCode;
        errorMessage: string;
      } {
    const reason: SessionTerminationReason =
      params.reason ?? 'user_top_bar_disconnect';
    const subReason = params.subReason || reason;
    const detectionTimeMs = Math.max(
      1,
      Math.round(params.detectionTimeMs ?? 1)
    );

    let targetSessionId = params.sessionId;
    if (!targetSessionId && params.callerAccountId) {
      const activeForCaller = this.getActiveSessionForAccount(
        params.callerAccountId
      );
      if (activeForCaller) {
        targetSessionId = activeForCaller.sessionId;
      } else {
        for (const [sid, entry] of this.terminatedSessions.entries()) {
          if (
            entry.session.hostAccountId === params.callerAccountId ||
            entry.session.guestAccountId === params.callerAccountId
          ) {
            targetSessionId = sid;
          }
        }
      }
    }

    if (!targetSessionId) {
      return {
        ok: false,
        status: 403,
        errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
        errorMessage: 'No active session found for caller.',
      };
    }

    const active = this.activeSessions.get(targetSessionId);
    if (active) {
      if (
        params.callerAccountId &&
        active.hostAccountId !== params.callerAccountId &&
        active.guestAccountId !== params.callerAccountId
      ) {
        return {
          ok: false,
          status: 403,
          errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
          errorMessage: 'Caller is not a participant of this session.',
        };
      }

      this.activeSessions.delete(active.sessionId);
      this.sessionSignals.delete(active.sessionId);
      this.sessionHeartbeats.delete(active.sessionId);

      const receipt: SessionTeardownReceipt = {
        sessionId: active.sessionId,
        reason,
        subReason,
        initiatedByAccountId: params.callerAccountId ?? null,
        terminatedAt: new Date().toISOString(),
        alreadyEnded: false,
        duplicateCallCount: 0,
        hostTracksStoppedCount: 0,
        peerConnectionsClosed: true,
        dataChannelsClosed: true,
        guestViewerCleared: true,
        permissionsInvalidated: true,
        signalingMembershipInvalidated: true,
        detectionTimeMs,
      };

      this.terminatedSessions.set(active.sessionId, {
        session: active,
        receipt,
      });

      return {
        ok: true,
        status: 200,
        disconnected: true,
        alreadyEnded: false,
        receipt,
      };
    }

    const existingTerminated = this.terminatedSessions.get(targetSessionId);
    if (existingTerminated) {
      if (
        params.callerAccountId &&
        existingTerminated.session.hostAccountId !== params.callerAccountId &&
        existingTerminated.session.guestAccountId !== params.callerAccountId
      ) {
        return {
          ok: false,
          status: 403,
          errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
          errorMessage: 'Caller was not a participant of this session.',
        };
      }

      const updatedReceipt: SessionTeardownReceipt = {
        ...existingTerminated.receipt,
        alreadyEnded: true,
        duplicateCallCount: existingTerminated.receipt.duplicateCallCount + 1,
      };
      existingTerminated.receipt = updatedReceipt;

      return {
        ok: true,
        status: 200,
        disconnected: true,
        alreadyEnded: true,
        receipt: updatedReceipt,
      };
    }

    return {
      ok: false,
      status: 403,
      errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
      errorMessage: 'No active session found for caller.',
    };
  }

  public signOut(): { signedOut: boolean } {
    const current = this.getCurrentAccount();
    if (current) {
      this.setAccountOfflineInternal(
        current.accountId,
        'app_closed',
        'user_signed_out'
      );
    }
    this.persisted.activeToken = null;
    this.persisted.activePersonaKey = null;
    this.savePersistedState();
    return { signedOut: true };
  }

  private setAccountOfflineInternal(
    accountId: string,
    reason: SessionTerminationReason = 'connection_lost',
    subReason: string = 'peer_offline'
  ): SessionTeardownReceipt | null {
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
      const res = this.teardownSessionIdempotent({
        sessionId: active.sessionId,
        callerAccountId: accountId,
        reason,
        subReason,
      });
      return res.ok ? res.receipt : null;
    }
    return null;
  }

  public async getPresenceSnapshot(): Promise<
    ApiActionResult<{
      snapshot: PresenceStateSnapshot;
    }>
  > {
    if (this.isRemoteDeviceMode()) {
      return this.fetchRemoteApi<{ snapshot: PresenceStateSnapshot }>(
        '/presence/state',
        { method: 'GET' }
      );
    }
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

  public async setPresenceOnline(
    online: boolean,
    options?: {
      personaKey?: string;
      reason?: SessionTerminationReason;
      subReason?: string;
    }
  ): Promise<
    ApiActionResult<{
      snapshot: PresenceStateSnapshot;
      receipt?: SessionTeardownReceipt | null;
    }>
  > {
    if (!options?.personaKey && this.isRemoteDeviceMode()) {
      if (online) {
        return this.fetchRemoteApi<{
          snapshot: PresenceStateSnapshot;
          receipt?: SessionTeardownReceipt | null;
        }>('/presence/connect', {
          method: 'POST',
          body: '{}',
        });
      }
      const disc = await this.fetchRemoteApi<{
        ok: boolean;
        receipt?: SessionTeardownReceipt | null;
      }>('/presence/disconnect', {
        method: 'POST',
        body: JSON.stringify({
          reason: options?.reason ?? 'connection_lost',
          subReason:
            options?.subReason ?? options?.reason ?? 'connection_lost',
        }),
      });
      if (!disc.ok) {
        return {
          ok: false,
          status: disc.status,
          errorCode: disc.errorCode,
          errorMessage: disc.errorMessage,
        };
      }
      const stateRes = await this.fetchRemoteApi<{
        snapshot: PresenceStateSnapshot;
      }>('/presence/state', { method: 'GET' });
      if (!stateRes.ok || !stateRes.data) {
        return {
          ok: false,
          status: stateRes.status,
          errorCode: stateRes.errorCode,
          errorMessage: stateRes.errorMessage,
        };
      }
      return {
        ok: true,
        status: 200,
        data: {
          snapshot: stateRes.data.snapshot,
          receipt: disc.data?.receipt ?? null,
        },
      };
    }

    const targetAccount = options?.personaKey
      ? this.getAccountByPersona(options.personaKey)
      : this.getCurrentAccount();

    if (!targetAccount) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    let receipt: SessionTeardownReceipt | null = null;
    if (online) {
      // Restoring internet or reopening the app reconnects presence,
      // but NEVER restarts or restores an ended session.
      this.onlineAccounts.add(targetAccount.accountId);
    } else {
      receipt = this.setAccountOfflineInternal(
        targetAccount.accountId,
        options?.reason ?? 'connection_lost',
        options?.subReason ?? options?.reason ?? 'connection_lost'
      );
    }

    return {
      ok: true,
      status: 200,
      data: {
        snapshot: this.buildSnapshot(targetAccount),
        receipt,
      },
    };
  }

  public async sendFriendCodeInvite(
    rawFriendCode: string
  ): Promise<
    ApiActionResult<{ invite: InviteSummary; snapshot: PresenceStateSnapshot }>
  > {
    if (this.isRemoteDeviceMode()) {
      return this.fetchRemoteApi<{
        invite: InviteSummary;
        snapshot: PresenceStateSnapshot;
      }>('/invites', {
        method: 'POST',
        body: JSON.stringify({ friendCode: rawFriendCode }),
      });
    }
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

  public async respondToInvite(params: {
    inviteId: string;
    action: 'accept' | 'decline';
    mediaSelection?: HostMediaSelection;
  }): Promise<
    ApiActionResult<{
      invite: InviteSummary;
      session: ApprovedSessionSummary | null;
      snapshot: PresenceStateSnapshot;
    }>
  > {
    if (this.isRemoteDeviceMode()) {
      return this.fetchRemoteApi<{
        invite: InviteSummary;
        session: ApprovedSessionSummary | null;
        snapshot: PresenceStateSnapshot;
      }>(`/invites/${encodeURIComponent(params.inviteId)}/respond`, {
        method: 'POST',
        body: JSON.stringify({
          action: params.action,
          mediaSelection: params.mediaSelection,
        }),
      });
    }
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
    const nowMs = Date.now();
    this.sessionHeartbeats.set(approvedSession.sessionId, {
      lastHostHeartbeatMs: nowMs,
      lastGuestHeartbeatMs: nowMs,
    });

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

  public async disconnectActiveSession(
    sessionIdOrOptions?:
      | string
      | {
          sessionId?: string;
          reason?: SessionTerminationReason;
          subReason?: string;
          callerAccountId?: string;
          detectionTimeMs?: number;
        }
  ): Promise<
    ApiActionResult<{
      disconnected: boolean;
      alreadyEnded: boolean;
      receipt: SessionTeardownReceipt;
      snapshot: PresenceStateSnapshot;
    }>
  > {
    const opts =
      typeof sessionIdOrOptions === 'string'
        ? { sessionId: sessionIdOrOptions }
        : sessionIdOrOptions ?? {};

    if (this.isRemoteDeviceMode()) {
      return this.fetchRemoteApi<{
        disconnected: boolean;
        alreadyEnded: boolean;
        receipt: SessionTeardownReceipt;
        snapshot: PresenceStateSnapshot;
      }>('/sessions/disconnect', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: opts.sessionId,
          reason: opts.reason ?? 'user_top_bar_disconnect',
          subReason: opts.subReason,
        }),
      });
    }

    const current = this.getCurrentAccount();

    const callerAccountId = opts.callerAccountId || current?.accountId;
    if (!callerAccountId) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    const result = this.teardownSessionIdempotent({
      sessionId: opts.sessionId,
      callerAccountId,
      reason: opts.reason ?? 'user_top_bar_disconnect',
      subReason: opts.subReason,
      detectionTimeMs: opts.detectionTimeMs,
    });

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      };
    }

    const snapshotAccount =
      current ??
      this.persisted.d1Accounts
        .map((r) => this.mapAccountRow(r))
        .find((a) => a.accountId === callerAccountId)!;

    return {
      ok: true,
      status: 200,
      data: {
        disconnected: true,
        alreadyEnded: result.alreadyEnded,
        receipt: result.receipt,
        snapshot: this.buildSnapshot(snapshotAccount),
      },
    };
  }

  public recordSessionHeartbeat(params: {
    sessionId: string;
    callerAccountId?: string;
    timestampMs?: number;
  }): ApiActionResult<{
    ok: boolean;
    sessionId: string;
    heartbeatAtMs: number;
  }> {
    const current = this.getCurrentAccount();
    const callerId = params.callerAccountId || current?.accountId;
    if (!callerId) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    const session = this.activeSessions.get(params.sessionId);
    if (!session) {
      const terminated = this.terminatedSessions.get(params.sessionId);
      if (terminated) {
        return {
          ok: false,
          status: 409,
          errorCode: 'SESSION_ALREADY_ENDED',
          errorMessage: `Stale session heartbeat rejected: session ${params.sessionId} has already ended (${terminated.receipt.reason}) and can never be resumed.`,
        };
      }
      return {
        ok: false,
        status: 403,
        errorCode: 'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE',
        errorMessage: 'No active session found for heartbeat.',
      };
    }

    if (
      session.hostAccountId !== callerId &&
      session.guestAccountId !== callerId
    ) {
      return {
        ok: false,
        status: 403,
        errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
        errorMessage: 'Caller is not an approved participant of this session.',
      };
    }

    const nowMs = params.timestampMs ?? Date.now();
    const hb = this.sessionHeartbeats.get(session.sessionId) ?? {
      lastHostHeartbeatMs: nowMs,
      lastGuestHeartbeatMs: nowMs,
    };

    if (callerId === session.hostAccountId) {
      hb.lastHostHeartbeatMs = nowMs;
    } else {
      hb.lastGuestHeartbeatMs = nowMs;
    }
    this.sessionHeartbeats.set(session.sessionId, hb);

    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        sessionId: session.sessionId,
        heartbeatAtMs: nowMs,
      },
    };
  }

  public checkSessionLiveness(params: {
    sessionId: string;
    callerAccountId?: string;
    nowMs?: number;
    livenessTimeoutMs?: number;
  }): ApiActionResult<{
    alive: boolean;
    alreadyEnded: boolean;
    sessionId: string;
    hostHeartbeatAgeMs: number;
    guestHeartbeatAgeMs: number;
    livenessTimeoutMs: number;
    sessionDurationMs: number;
    receipt?: SessionTeardownReceipt;
  }> {
    const current = this.getCurrentAccount();
    const callerId = params.callerAccountId || current?.accountId;
    if (!callerId) {
      return {
        ok: false,
        status: 401,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'Not signed in.',
      };
    }

    const session = this.activeSessions.get(params.sessionId);
    if (!session) {
      const terminated = this.terminatedSessions.get(params.sessionId);
      if (terminated) {
        return {
          ok: true,
          status: 200,
          data: {
            alive: false,
            alreadyEnded: true,
            sessionId: params.sessionId,
            hostHeartbeatAgeMs: 0,
            guestHeartbeatAgeMs: 0,
            livenessTimeoutMs:
              params.livenessTimeoutMs ??
              DEFAULT_LIVENESS_CONFIG.livenessTimeoutMs,
            sessionDurationMs: 0,
            receipt: terminated.receipt,
          },
        };
      }
      return {
        ok: false,
        status: 403,
        errorCode: 'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE',
        errorMessage: 'Session not found.',
      };
    }

    const nowMs = params.nowMs ?? Date.now();
    const timeoutMs =
      params.livenessTimeoutMs ?? DEFAULT_LIVENESS_CONFIG.livenessTimeoutMs;
    const hb = this.sessionHeartbeats.get(session.sessionId) ?? {
      lastHostHeartbeatMs: Date.parse(session.createdAt),
      lastGuestHeartbeatMs: Date.parse(session.createdAt),
    };

    const hostAgeMs = Math.max(0, nowMs - hb.lastHostHeartbeatMs);
    const guestAgeMs = Math.max(0, nowMs - hb.lastGuestHeartbeatMs);
    const sessionDurationMs = Math.max(
      0,
      nowMs - Date.parse(session.createdAt)
    );

    const hostExpired =
      hostAgeMs > timeoutMs || !this.onlineAccounts.has(session.hostAccountId);
    const guestExpired =
      guestAgeMs > timeoutMs || !this.onlineAccounts.has(session.guestAccountId);

    if (hostExpired || guestExpired) {
      const subReason =
        hostExpired && guestExpired
          ? 'liveness_timeout_both_peers'
          : hostExpired
          ? 'liveness_timeout_host_a'
          : 'liveness_timeout_guest_b';

      const teardown = this.teardownSessionIdempotent({
        sessionId: session.sessionId,
        callerAccountId: callerId,
        reason: 'connection_lost',
        subReason,
        detectionTimeMs: Math.max(1, Math.max(hostAgeMs, guestAgeMs)),
      });

      return {
        ok: true,
        status: 200,
        data: {
          alive: false,
          alreadyEnded: teardown.ok ? teardown.alreadyEnded : false,
          sessionId: session.sessionId,
          hostHeartbeatAgeMs: hostAgeMs,
          guestHeartbeatAgeMs: guestAgeMs,
          livenessTimeoutMs: timeoutMs,
          sessionDurationMs,
          receipt: teardown.ok ? teardown.receipt : undefined,
        },
      };
    }

    return {
      ok: true,
      status: 200,
      data: {
        alive: true,
        alreadyEnded: false,
        sessionId: session.sessionId,
        hostHeartbeatAgeMs: hostAgeMs,
        guestHeartbeatAgeMs: guestAgeMs,
        livenessTimeoutMs: timeoutMs,
        sessionDurationMs,
      },
    };
  }

  public async sendSessionSignal(params: {
    sessionId: string;
    senderAccountId?: string;
    payload: WebRtcSignalPayload;
  }): Promise<
    ApiActionResult<{
      admitted: boolean;
      session: ApprovedSessionSummary;
      envelope: WebRtcSignalEnvelope;
    }>
  > {
    if (this.isRemoteDeviceMode()) {
      return this.fetchRemoteApi<{
        admitted: boolean;
        session: ApprovedSessionSummary;
        envelope: WebRtcSignalEnvelope;
      }>('/sessions/signal', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: params.sessionId,
          signalType: params.payload.type,
          payload: params.payload,
        }),
      });
    }
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
      const terminated = this.terminatedSessions.get(params.sessionId);
      if (terminated) {
        if (
          terminated.session.hostAccountId !== senderId &&
          terminated.session.guestAccountId !== senderId
        ) {
          return {
            ok: false,
            status: 403,
            errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
            errorMessage:
              'Caller is not an approved participant of this 1:1 session.',
          };
        }
        return {
          ok: false,
          status: 409,
          errorCode: 'SESSION_ALREADY_ENDED',
          errorMessage: `Stale session event rejected: session ${params.sessionId} has already ended (${terminated.receipt.reason}) and can never be resumed. Send a fresh invite and accept again.`,
        };
      }
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
      pType !== 'media-status' &&
      pType !== 'teardown'
    ) {
      return {
        ok: false,
        status: 400,
        errorCode: 'INVALID_SIGNAL_PAYLOAD',
        errorMessage:
          'Coordinator only accepts WebRTC signaling payloads (offer, answer, ice-candidate, media-status, teardown), never media frames or chat payloads.',
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

  public async pollSessionSignals(params: {
    sessionId: string;
    receiverAccountId?: string;
    afterSeq: number;
  }): Promise<
    ApiActionResult<{
      session: ApprovedSessionSummary;
      signals: readonly WebRtcSignalEnvelope[];
    }>
  > {
    if (this.isRemoteDeviceMode()) {
      const qs = new URLSearchParams({
        sessionId: params.sessionId,
        afterSeq: String(params.afterSeq ?? 0),
      });
      return this.fetchRemoteApi<{
        session: ApprovedSessionSummary;
        signals: readonly WebRtcSignalEnvelope[];
      }>(`/sessions/signals?${qs.toString()}`, {
        method: 'GET',
      });
    }
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
      const terminated = this.terminatedSessions.get(params.sessionId);
      if (terminated) {
        if (
          terminated.session.hostAccountId !== receiverId &&
          terminated.session.guestAccountId !== receiverId
        ) {
          return {
            ok: false,
            status: 403,
            errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
            errorMessage:
              'Caller is not an approved participant of this 1:1 session.',
          };
        }
        return {
          ok: false,
          status: 409,
          errorCode: 'SESSION_ALREADY_ENDED',
          errorMessage: `Stale session poll rejected: session ${params.sessionId} has already ended (${terminated.receipt.reason}) and can never be resumed.`,
        };
      }
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
