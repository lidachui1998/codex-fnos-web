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

test("migrates existing scheduled tasks to the safe workspace sandbox", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-schedule-migration-"));
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      network_access INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      reasoning_effort TEXT,
      source_automation_id TEXT,
      source_cwd TEXT,
      source_prompt TEXT,
      memory_text TEXT,
      compatibility_json TEXT NOT NULL DEFAULT '[]',
      next_run_at INTEGER,
      last_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO scheduled_tasks (
      id, name, project_id, prompt, schedule_json, enabled, network_access,
      compatibility_json, created_at, updated_at
    ) VALUES (
      'schedule-1', 'Legacy schedule', 'project-1', 'Run it',
      '{"type":"daily","time":"09:00"}', 1, 1, '[]', 1, 1
    );
  `);
  legacy.close();

  const migrated = openDatabase(path);
  try {
    assert.equal(
      migrated.prepare("SELECT sandbox_mode FROM scheduled_tasks WHERE id = 'schedule-1'").get().sandbox_mode,
      "workspace",
    );
  } finally {
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("enables network access once for existing chats without overriding later choices", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-network-migration-"));
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread_preferences (
      thread_id TEXT PRIMARY KEY,
      approval_policy TEXT NOT NULL,
      display_name TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      archived_local INTEGER NOT NULL DEFAULT 0,
      network_access INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO settings VALUES ('network_access_default', 'false');
    INSERT INTO thread_preferences (thread_id, approval_policy, network_access, updated_at)
      VALUES ('thread-1', 'on-request', 0, 1);
  `);
  legacy.close();

  let migrated = openDatabase(path);
  assert.equal(migrated.prepare("SELECT value FROM settings WHERE key = 'network_access_default'").get().value, "true");
  assert.equal(migrated.prepare("SELECT network_access FROM thread_preferences WHERE thread_id = 'thread-1'").get().network_access, 1);
  migrated.prepare("UPDATE settings SET value = 'false' WHERE key = 'network_access_default'").run();
  migrated.prepare("UPDATE thread_preferences SET network_access = 0 WHERE thread_id = 'thread-1'").run();
  migrated.close();

  migrated = openDatabase(path);
  try {
    assert.equal(migrated.prepare("SELECT value FROM settings WHERE key = 'network_access_default'").get().value, "false");
    assert.equal(migrated.prepare("SELECT network_access FROM thread_preferences WHERE thread_id = 'thread-1'").get().network_access, 0);
  } finally {
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  }
});
