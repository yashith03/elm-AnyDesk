-- Migration 0002: Anonymous Device Credentials
-- Protects each anonymous device installation with a salted/hashed private device credential
-- while assigning public device codes through the single `accounts` registry (UNIQUE friend_code).

CREATE TABLE IF NOT EXISTS device_credentials (
  device_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
