import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 67108864;");
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
      reasoning_profile TEXT NOT NULL DEFAULT 'auto',
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

    CREATE TABLE IF NOT EXISTS codex_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      home_key TEXT NOT NULL UNIQUE,
      account_type TEXT,
      email TEXT,
      plan_type TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_preferences (
      thread_id TEXT PRIMARY KEY,
      approval_policy TEXT NOT NULL CHECK (approval_policy IN ('on-request', 'never')),
      display_name TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      archived_local INTEGER NOT NULL DEFAULT 0,
      network_access INTEGER NOT NULL DEFAULT 1,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      network_access INTEGER NOT NULL DEFAULT 0,
      sandbox_mode TEXT NOT NULL DEFAULT 'workspace' CHECK (sandbox_mode IN ('workspace', 'unrestricted')),
      provider_mode TEXT NOT NULL DEFAULT 'follow' CHECK (provider_mode IN ('follow', 'openai', 'provider')),
      provider_id TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
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

    CREATE TABLE IF NOT EXISTS queued_messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES codex_accounts(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      display_payload_json TEXT NOT NULL,
      turn_input_json TEXT NOT NULL,
      approval_policy TEXT NOT NULL CHECK (approval_policy IN ('on-request', 'never')),
      network_access INTEGER NOT NULL DEFAULT 1,
      model TEXT,
      reasoning_effort TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dispatching', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      thread_id TEXT,
      turn_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      output TEXT,
      error TEXT,
      phase TEXT NOT NULL DEFAULT 'created',
      last_event_at INTEGER,
      diagnostics_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'timeout', 'waiting')),
      source TEXT NOT NULL CHECK (source IN ('chat', 'scheduled')),
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      thread_id TEXT,
      turn_id TEXT,
      project_id TEXT,
      schedule_id TEXT REFERENCES scheduled_tasks(id) ON DELETE SET NULL,
      schedule_run_id TEXT REFERENCES scheduled_runs(id) ON DELETE SET NULL,
      is_read INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_channels (
      channel TEXT PRIMARY KEY CHECK (channel IN ('fnos', 'feishu', 'hermes')),
      enabled INTEGER NOT NULL DEFAULT 0,
      webhook_url_encrypted TEXT,
      webhook_url_hint TEXT,
      secret_encrypted TEXT,
      secret_hint TEXT,
      events_json TEXT NOT NULL DEFAULT '["completed","failed","timeout","waiting"]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('feishu', 'hermes')),
      event_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
      error TEXT,
      attempted_at INTEGER NOT NULL,
      UNIQUE(notification_id, channel, event_type)
    );

    CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx ON scheduled_tasks(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS queued_messages_account_thread_idx ON queued_messages(account_id, thread_id, created_at);
    CREATE INDEX IF NOT EXISTS scheduled_runs_task_idx ON scheduled_runs(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS notifications_updated_idx ON notifications(updated_at DESC);
    CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(is_read, updated_at DESC);
    CREATE INDEX IF NOT EXISTS codex_accounts_used_idx ON codex_accounts(last_used_at DESC);
  `);

  const timestamp = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO notification_channels (channel, enabled, created_at, updated_at)
    VALUES ('fnos', 1, ?, ?)
    ON CONFLICT(channel) DO NOTHING
  `).run(timestamp, timestamp);
  for (const channel of ["feishu", "hermes"]) {
    db.prepare(`
      INSERT INTO notification_channels (channel, enabled, created_at, updated_at)
      VALUES (?, 0, ?, ?)
      ON CONFLICT(channel) DO NOTHING
    `).run(channel, timestamp, timestamp);
  }

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
  if (!providerColumns.has("reasoning_profile")) db.exec("ALTER TABLE provider_profiles ADD COLUMN reasoning_profile TEXT NOT NULL DEFAULT 'auto'");
  const threadColumns = new Set(db.prepare("PRAGMA table_info(thread_preferences)").all().map((column) => column.name));
  if (!threadColumns.has("display_name")) db.exec("ALTER TABLE thread_preferences ADD COLUMN display_name TEXT");
  if (!threadColumns.has("pinned")) db.exec("ALTER TABLE thread_preferences ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!threadColumns.has("deleted")) db.exec("ALTER TABLE thread_preferences ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  if (!threadColumns.has("archived_local")) db.exec("ALTER TABLE thread_preferences ADD COLUMN archived_local INTEGER NOT NULL DEFAULT 0");
  if (!threadColumns.has("network_access")) db.exec("ALTER TABLE thread_preferences ADD COLUMN network_access INTEGER NOT NULL DEFAULT 1");
  if (!threadColumns.has("project_id")) db.exec("ALTER TABLE thread_preferences ADD COLUMN project_id TEXT");
  const scheduledTaskColumns = new Set(db.prepare("PRAGMA table_info(scheduled_tasks)").all().map((column) => column.name));
  for (const [column, definition] of [
    ["sandbox_mode", "TEXT NOT NULL DEFAULT 'workspace'"],
    ["provider_mode", "TEXT NOT NULL DEFAULT 'follow'"],
    ["provider_id", "TEXT"],
    ["model", "TEXT"],
    ["reasoning_effort", "TEXT"],
    ["source_automation_id", "TEXT"],
    ["source_cwd", "TEXT"],
    ["source_prompt", "TEXT"],
    ["memory_text", "TEXT"],
    ["compatibility_json", "TEXT NOT NULL DEFAULT '[]'"],
  ]) {
    if (!scheduledTaskColumns.has(column)) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN ${column} ${definition}`);
  }
  const scheduledRunColumns = new Set(db.prepare("PRAGMA table_info(scheduled_runs)").all().map((column) => column.name));
  for (const [column, definition] of [
    ["phase", "TEXT NOT NULL DEFAULT 'created'"],
    ["last_event_at", "INTEGER"],
    ["diagnostics_json", "TEXT NOT NULL DEFAULT '[]'"],
  ]) {
    if (!scheduledRunColumns.has(column)) db.exec(`ALTER TABLE scheduled_runs ADD COLUMN ${column} ${definition}`);
  }
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
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'network_access_default_v1'").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('network_access_default', 'true')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run();
      db.prepare("UPDATE thread_preferences SET network_access = 1, updated_at = ?").run(timestamp);
      db.prepare("INSERT INTO settings (key, value) VALUES ('network_access_default_v1', 'true')").run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'background_clarity_v1'").get()) {
    const appearance = Object.fromEntries(db.prepare(`
      SELECT key, value FROM settings
      WHERE key IN ('background_opacity', 'background_blur', 'background_panel_opacity')
    `).all().map((row) => [row.key, Number(row.value)]));
    const opacity = Number.isFinite(appearance.background_opacity) ? Math.max(appearance.background_opacity, 0.72) : 0.75;
    const blur = Number.isFinite(appearance.background_blur) ? Math.min(appearance.background_blur, 2) : 0;
    const panelOpacity = Number.isFinite(appearance.background_panel_opacity) ? Math.min(appearance.background_panel_opacity, 0.62) : 0.58;
    db.exec("BEGIN IMMEDIATE");
    try {
      const saveSetting = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      saveSetting.run("background_opacity", String(opacity));
      saveSetting.run("background_blur", String(blur));
      saveSetting.run("background_panel_opacity", String(panelOpacity));
      saveSetting.run("background_clarity_v1", "true");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.exec("PRAGMA optimize");
  return db;
}
