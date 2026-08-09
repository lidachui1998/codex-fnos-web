import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../database.mjs";

test("migrates legacy single-url proxies and provider assignments", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-migration-"));
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE proxy_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      url_encrypted TEXT, url_hint TEXT, no_proxy TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE provider_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
      base_url TEXT NOT NULL, model TEXT NOT NULL, api_key_encrypted TEXT,
      api_key_hint TEXT, headers_encrypted TEXT,
      proxy_profile_id TEXT REFERENCES proxy_profiles(id) ON DELETE SET NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO proxy_profiles VALUES (
      'proxy-1', 'legacy', 'http', 'encrypted-value', 'http://127.0.0.1:7890',
      '127.0.0.1,localhost', 1, 1, 1
    );
    INSERT INTO provider_profiles VALUES (
      'provider-1', 'legacy provider', 'responses', 'https://api.example.com/v1',
      'coder', NULL, NULL, NULL, 'proxy-1', 1, 1, 1
    );
  `);
  legacy.close();

  const migrated = openDatabase(path);
  try {
    const proxy = migrated.prepare("SELECT * FROM proxy_profiles WHERE id = 'proxy-1'").get();
    const provider = migrated.prepare("SELECT * FROM provider_profiles WHERE id = 'provider-1'").get();
    assert.equal(proxy.http_url_encrypted, "encrypted-value");
    assert.equal(proxy.http_url_hint, "http://127.0.0.1:7890");
    assert.equal(provider.proxy_mode, "profile");
    assert.equal(provider.reasoning_profile, "auto");
  } finally {
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  }
});
