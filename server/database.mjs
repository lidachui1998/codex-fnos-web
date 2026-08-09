import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'http', 'https', 'socks5')),
      url_encrypted TEXT,
      url_hint TEXT,
      http_url_encrypted TEXT,
      http_url_hint TEXT,
      https_url_encrypted TEXT,
      https_url_hint TEXT,
      socks5_url_encrypted TEXT,
      socks5_url_hint TEXT,
      no_proxy TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK (protocol IN ('responses', 'chat_completions')),
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key_encrypted TEXT,
      api_key_hint TEXT,
      headers_encrypted TEXT,
      proxy_profile_id TEXT REFERENCES proxy_profiles(id) ON DELETE SET NULL,
      proxy_mode TEXT NOT NULL DEFAULT 'inherit',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      default_provider_id TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
      instructions TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_preferences (
      thread_id TEXT PRIMARY KEY,
      approval_policy TEXT NOT NULL CHECK (approval_policy IN ('on-request', 'never')),
      updated_at INTEGER NOT NULL
    );
  `);

  const proxyColumns = new Set(db.prepare("PRAGMA table_info(proxy_profiles)").all().map((column) => column.name));
  for (const column of [
    "http_url_encrypted",
    "http_url_hint",
    "https_url_encrypted",
    "https_url_hint",
    "socks5_url_encrypted",
    "socks5_url_hint",
  ]) {
    if (!proxyColumns.has(column)) db.exec(`ALTER TABLE proxy_profiles ADD COLUMN ${column} TEXT`);
  }
  const providerColumns = new Set(db.prepare("PRAGMA table_info(provider_profiles)").all().map((column) => column.name));
  if (!providerColumns.has("proxy_mode")) db.exec("ALTER TABLE provider_profiles ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'inherit'");
  db.exec(`
    UPDATE proxy_profiles SET http_url_encrypted = url_encrypted, http_url_hint = url_hint
      WHERE kind = 'http' AND http_url_encrypted IS NULL;
    UPDATE proxy_profiles SET https_url_encrypted = url_encrypted, https_url_hint = url_hint
      WHERE kind = 'https' AND https_url_encrypted IS NULL;
    UPDATE proxy_profiles SET socks5_url_encrypted = url_encrypted, socks5_url_hint = url_hint
      WHERE kind = 'socks5' AND socks5_url_encrypted IS NULL;
    UPDATE provider_profiles SET proxy_mode = 'profile'
      WHERE proxy_profile_id IS NOT NULL AND proxy_mode = 'inherit';
  `);
  return db;
}
