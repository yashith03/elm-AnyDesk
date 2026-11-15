import {
  generateRandomFriendCode,
  normalizeFriendCode,
  type AccountProfile,
} from '@elm/protocol';
import type { VerifiedExternalIdentity } from '../auth/adapter.ts';

interface AccountRow {
  account_id: string;
  provider: string;
  provider_subject: string;
  display_name: string;
  friend_code: string;
  created_at: string;
  updated_at: string;
}

function mapRowToProfile(row: AccountRow): AccountProfile {
  return {
    accountId: row.account_id,
    provider: row.provider,
    providerSubject: row.provider_subject,
    displayName: row.display_name,
    friendCode: row.friend_code,
    createdAt: row.created_at,
  };
}

/**
 * Ensures the schema exists on D1 (safe idempotent guard in addition to migrations).
 */
export async function ensureAccountsSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        display_name TEXT NOT NULL,
        friend_code TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, provider_subject)
      )`
    )
    .run();
}

/**
 * Finds or creates an AccountProfile in D1 for the given verified external identity.
 * - If the account already exists, its permanent `account_id` and `friend_code` are
 *   reused without regeneration across all sign-ins and restarts.
 * - If new, generates a unique random Friend Code (`ELM-XXXX-XXXX`) and stores it once.
 */
export async function ensureAccountWithPermanentFriendCode(
  db: D1Database,
  identity: VerifiedExternalIdentity,
  codeGenerator: () => string = () => generateRandomFriendCode()
): Promise<AccountProfile> {
  await ensureAccountsSchema(db);

  const existing = await db
    .prepare(
      `SELECT account_id, provider, provider_subject, display_name, friend_code, created_at, updated_at
       FROM accounts
       WHERE provider = ?1 AND provider_subject = ?2`
    )
    .bind(identity.provider, identity.providerSubject)
    .first<AccountRow>();

  const now = new Date().toISOString();

  if (existing) {
    if (existing.display_name !== identity.displayName) {
      await db
        .prepare(
          `UPDATE accounts
           SET display_name = ?1, updated_at = ?2
           WHERE account_id = ?3`
        )
        .bind(identity.displayName, now, existing.account_id)
        .run();
    }

    return mapRowToProfile({
      ...existing,
      display_name: identity.displayName,
      updated_at: now,
    });
  }

  const accountId = crypto.randomUUID();
  const maxAttempts = 12;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidateCode = normalizeFriendCode(codeGenerator());

    try {
      await db
        .prepare(
          `INSERT INTO accounts (
            account_id, provider, provider_subject, display_name, friend_code, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
        .bind(
          accountId,
          identity.provider,
          identity.providerSubject,
          identity.displayName,
          candidateCode,
          now,
          now
        )
        .run();

      return {
        accountId,
        provider: identity.provider,
        providerSubject: identity.providerSubject,
        displayName: identity.displayName,
        friendCode: candidateCode,
        createdAt: now,
      };
    } catch (err: unknown) {
      // Check if concurrent sign-in created the same (provider, provider_subject)
      const raceExisting = await db
        .prepare(
          `SELECT account_id, provider, provider_subject, display_name, friend_code, created_at, updated_at
           FROM accounts
           WHERE provider = ?1 AND provider_subject = ?2`
        )
        .bind(identity.provider, identity.providerSubject)
        .first<AccountRow>();

      if (raceExisting) {
        return mapRowToProfile(raceExisting);
      }

      if (attempt === maxAttempts - 1) {
        throw err;
      }
    }
  }

  throw new Error('Failed to allocate unique Friend Code after maximum retries.');
}

export async function findAccountByFriendCode(
  db: D1Database,
  rawFriendCode: string
): Promise<AccountProfile | null> {
  await ensureAccountsSchema(db);
  const code = normalizeFriendCode(rawFriendCode);
  const row = await db
    .prepare(
      `SELECT account_id, provider, provider_subject, display_name, friend_code, created_at, updated_at
       FROM accounts
       WHERE friend_code = ?1`
    )
    .bind(code)
    .first<AccountRow>();

  return row ? mapRowToProfile(row) : null;
}

export async function findAccountById(
  db: D1Database,
  accountId: string
): Promise<AccountProfile | null> {
  await ensureAccountsSchema(db);
  const row = await db
    .prepare(
      `SELECT account_id, provider, provider_subject, display_name, friend_code, created_at, updated_at
       FROM accounts
       WHERE account_id = ?1`
    )
    .bind(accountId)
    .first<AccountRow>();

  return row ? mapRowToProfile(row) : null;
}

interface DeviceCredentialRow {
  device_id: string;
  secret_hash: string;
  account_id: string;
  created_at: string;
}

async function hashDeviceSecret(secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function ensureDeviceCredentialsSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS device_credentials (
        device_id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    )
    .run();
}

/**
 * Idempotent anonymous device registration backed by the single `accounts` registry.
 * - Protects the installation via a SHA-256 hash of `deviceSecret`.
 * - Assigns a unique `ELM-XXXX-XXXX` device code with `UNIQUE(friend_code)` collision retry.
 * - Retrying registration with the same `(deviceId, deviceSecret)` returns the exact same code.
 */
export async function registerAnonymousDevice(
  db: D1Database,
  params: { deviceId: string; deviceSecret: string },
  codeGenerator: () => string = () => generateRandomFriendCode()
): Promise<
  | { account: AccountProfile; alreadyRegistered: boolean }
  | { error: 'INVALID_DEVICE_CREDENTIAL' | 'DEVICE_SECRET_MISMATCH' }
> {
  const deviceId = params.deviceId.trim();
  const deviceSecret = params.deviceSecret.trim();
  if (deviceId.length < 16 || deviceSecret.length < 32) {
    return { error: 'INVALID_DEVICE_CREDENTIAL' };
  }

  await ensureAccountsSchema(db);
  await ensureDeviceCredentialsSchema(db);

  const secretHash = await hashDeviceSecret(deviceSecret);
  const existingCred = await db
    .prepare(
      `SELECT device_id, secret_hash, account_id, created_at
       FROM device_credentials
       WHERE device_id = ?1`
    )
    .bind(deviceId)
    .first<DeviceCredentialRow>();

  if (existingCred) {
    if (!timingSafeEqualHex(existingCred.secret_hash, secretHash)) {
      return { error: 'DEVICE_SECRET_MISMATCH' };
    }
    const account = await ensureAccountWithPermanentFriendCode(
      db,
      {
        provider: 'device',
        providerSubject: deviceId,
        displayName: 'Elm Device',
      },
      codeGenerator
    );
    return { account, alreadyRegistered: true };
  }

  const account = await ensureAccountWithPermanentFriendCode(
    db,
    {
      provider: 'device',
      providerSubject: deviceId,
      displayName: 'Elm Device',
    },
    codeGenerator
  );

  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO device_credentials (device_id, secret_hash, account_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`
      )
      .bind(deviceId, secretHash, account.accountId, now)
      .run();
  } catch {
    // Handle concurrent first-time registration race idempotently
    const raced = await db
      .prepare(
        `SELECT device_id, secret_hash, account_id, created_at
         FROM device_credentials
         WHERE device_id = ?1`
      )
      .bind(deviceId)
      .first<DeviceCredentialRow>();
    if (!raced || !timingSafeEqualHex(raced.secret_hash, secretHash)) {
      return { error: 'DEVICE_SECRET_MISMATCH' };
    }
    return { account, alreadyRegistered: true };
  }

  return { account, alreadyRegistered: false };
}
