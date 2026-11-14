-- Migration 0001: Accounts and Permanent Reusable Friend Codes
-- Each signed-in external identity receives a stable account_id and a unique,
-- randomly generated Friend Code created once and reused across restarts and sign-ins.

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  friend_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_subject)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_friend_code
  ON accounts(friend_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_identity
  ON accounts(provider, provider_subject);
