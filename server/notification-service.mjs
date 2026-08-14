import { createHmac, randomUUID } from "node:crypto";
import fetch from "node-fetch";
import { createProviderAgent } from "./provider-client.mjs";
import { decryptSecret, encryptSecret, secretHint } from "./lib/security.mjs";

const now = () => Math.floor(Date.now() / 1000);
const eventTypes = new Set(["completed", "failed", "timeout", "waiting"]);
const externalChannels = new Set(["feishu", "hermes"]);

function truncate(value, length = 900) {
  const text = String(value || "").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function safeError(error) {
  return truncate(error?.cause?.message || error?.message || error || "通知发送失败", 500)
    .replace(/https?:\/\/\S+/gi, "[webhook]");
}

function parseEvents(value) {
  let items = value;
  if (typeof value === "string") {
    try {
      items = JSON.parse(value);
    } catch {
      items = [];
    }
  }
  return [...new Set((Array.isArray(items) ? items : []).map(String).filter((item) => eventTypes.has(item)))];
}

function normalizeUrl(value) {
  const url = new URL(String(value).trim());
  if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("Webhook 地址必须使用 HTTP 或 HTTPS"), { status: 400 });
  return url.toString();
}

function isPrivateWebhook(value) {
  const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "::1", "0:0:0:0:0:0:0:1"].includes(host) || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function urlHint(value) {
  if (!value) return null;
  const url = new URL(value);
  const path = url.pathname.length > 18 ? `${url.pathname.slice(0, 12)}…` : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

function turnOutput(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const item = [...items].reverse().find((entry) => ["agentMessage", "plan"].includes(entry?.type) && String(entry.text || "").trim());
  return truncate(item?.text, 900);
}

function looksLikeTimeout(value) {
  return /timed?\s*out|timeout|超时/i.test(String(value || ""));
}

function publicNotification(row) {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    title: row.title,
    message: row.message,
    threadId: row.thread_id,
    turnId: row.turn_id,
    projectId: row.resolved_project_id || row.project_id,
    scheduleId: row.schedule_id,
    scheduleRunId: row.schedule_run_id,
    read: Boolean(row.is_read),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class NotificationService {
  constructor({ stores, bridge, getProxy = () => null, onChanged = () => {}, fetchImpl = fetch }) {
    this.stores = stores;
    this.bridge = bridge;
    this.getProxy = getProxy;
    this.onChanged = onChanged;
    this.fetchImpl = fetchImpl;
    this.pendingRequests = new Map();
    this.eventHandler = (event) => this.#handleBridgeEvent(event);
    bridge.on("event", this.eventHandler);
  }

  close() {
    this.bridge.off("event", this.eventHandler);
  }

  summary() {
    const row = this.stores.db.prepare(`
      SELECT
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN source = 'scheduled' THEN 1 ELSE 0 END) AS scheduled
      FROM notifications
    `).get();
    return {
      unread: Number(row?.unread || 0),
      running: Number(row?.running || 0),
      failed: Number(row?.failed || 0),
      scheduled: Number(row?.scheduled || 0),
    };
  }

  list({ filter = "all", limit = 100 } = {}) {
    const where = {
      all: "1 = 1",
      unread: "n.is_read = 0",
      running: "n.status = 'running'",
      failed: "n.status IN ('failed', 'timeout')",
      scheduled: "n.source = 'scheduled'",
    }[filter];
    if (!where) throw Object.assign(new Error("通知筛选条件无效"), { status: 400 });
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const data = this.stores.db.prepare(`
      SELECT n.*, COALESCE(n.project_id, tp.project_id) AS resolved_project_id
      FROM notifications n
      LEFT JOIN thread_preferences tp ON tp.thread_id = n.thread_id
      WHERE ${where}
      ORDER BY n.updated_at DESC LIMIT ?
    `).all(safeLimit).map(publicNotification);
    return { data, summary: this.summary() };
  }

  markRead(id, read = true) {
    const changed = this.stores.db.prepare("UPDATE notifications SET is_read = ?, updated_at = updated_at WHERE id = ?")
      .run(read ? 1 : 0, id).changes > 0;
    if (changed) this.#changed();
    return changed;
  }

  markAllRead() {
    const changes = this.stores.db.prepare("UPDATE notifications SET is_read = 1 WHERE is_read = 0").run().changes;
    if (changes > 0) this.#changed();
    return changes;
  }

  listChannels() {
    return this.stores.db.prepare("SELECT * FROM notification_channels ORDER BY CASE channel WHEN 'fnos' THEN 0 WHEN 'feishu' THEN 1 ELSE 2 END").all()
      .map((row) => ({
        channel: row.channel,
        enabled: row.channel === "fnos" ? true : Boolean(row.enabled),
        webhookUrlHint: row.webhook_url_hint,
        hasWebhookUrl: Boolean(row.webhook_url_encrypted),
        secretHint: row.secret_hint,
        hasSecret: Boolean(row.secret_encrypted),
        events: parseEvents(row.events_json),
        updatedAt: row.updated_at,
      }));
  }

  getChannelSecret(channel) {
    const row = this.stores.db.prepare("SELECT * FROM notification_channels WHERE channel = ?").get(channel);
    if (!row) return null;
    return {
      ...row,
      webhookUrl: decryptSecret(row.webhook_url_encrypted, this.stores.masterKey),
      secret: decryptSecret(row.secret_encrypted, this.stores.masterKey),
      events: parseEvents(row.events_json),
    };
  }

  saveChannel(channel, input) {
    if (!["fnos", ...externalChannels].includes(channel)) throw Object.assign(new Error("通知渠道无效"), { status: 404 });
    const existing = this.getChannelSecret(channel);
    if (!existing) throw Object.assign(new Error("通知渠道不存在"), { status: 404 });
    if (channel === "fnos") return this.listChannels().find((item) => item.channel === channel);
    const webhookUrl = input.clearWebhook
      ? ""
      : String(input.webhookUrl || "").trim() || existing.webhookUrl;
    const secret = input.clearSecret
      ? ""
      : input.secret === undefined || input.secret === "" ? existing.secret : String(input.secret).trim();
    const enabled = input.enabled ?? Boolean(existing.enabled);
    const events = input.events === undefined ? existing.events : parseEvents(input.events);
    if (enabled && !webhookUrl) throw Object.assign(new Error("启用通知前请填写 Webhook 地址"), { status: 400 });
    if (enabled && channel === "hermes" && !secret) throw Object.assign(new Error("Hermes 通知必须填写 notify 路由 secret"), { status: 400 });
    const normalizedUrl = webhookUrl ? normalizeUrl(webhookUrl) : "";
    const timestamp = now();
    this.stores.db.prepare(`
      UPDATE notification_channels SET enabled = ?, webhook_url_encrypted = ?, webhook_url_hint = ?,
        secret_encrypted = ?, secret_hint = ?, events_json = ?, updated_at = ? WHERE channel = ?
    `).run(
      enabled ? 1 : 0,
      encryptSecret(normalizedUrl, this.stores.masterKey),
      urlHint(normalizedUrl),
      encryptSecret(secret, this.stores.masterKey),
      secretHint(secret),
      JSON.stringify(events),
      timestamp,
      channel,
    );
    return this.listChannels().find((item) => item.channel === channel);
  }

  async testChannel(channel) {
    if (channel === "fnos") {
      const row = this.#upsert({
        eventKey: `test:${randomUUID()}`,
        status: "completed",
        source: "chat",
        title: "fnOS 通知中心测试",
        message: "本地通知中心工作正常。",
      }, { dispatch: false });
      return { ok: true, channel, notification: publicNotification(row) };
    }
    const config = this.getChannelSecret(channel);
    if (!config?.enabled) throw Object.assign(new Error("请先保存并启用这个通知渠道"), { status: 409 });
    await this.#send(channel, config, {
      status: "completed",
      source: "chat",
      title: "通知渠道测试",
      message: "Codex 飞牛工作台通知连接正常。",
      updated_at: now(),
    });
    return { ok: true, channel };
  }

  recordScheduledFailure(runId, error) {
    const context = this.#scheduleContextByRun(runId);
    if (!context) return null;
    const message = safeError(error);
    return this.#upsert({
      eventKey: `schedule-run:${runId}`,
      status: looksLikeTimeout(message) ? "timeout" : "failed",
      source: "scheduled",
      title: context.task_name,
      message,
      threadId: context.thread_id,
      turnId: context.turn_id,
      projectId: context.project_id,
      scheduleId: context.schedule_id,
      scheduleRunId: context.run_id,
    });
  }

  #scheduleContextByRun(runId) {
    return this.stores.db.prepare(`
      SELECT sr.id AS run_id, sr.thread_id, sr.turn_id, st.id AS schedule_id,
        st.name AS task_name, st.project_id, p.name AS project_name
      FROM scheduled_runs sr
      JOIN scheduled_tasks st ON st.id = sr.task_id
      LEFT JOIN projects p ON p.id = st.project_id
      WHERE sr.id = ?
    `).get(runId);
  }

  #contextForThread(threadId) {
    const scheduled = this.stores.db.prepare(`
      SELECT sr.id AS run_id, sr.turn_id, st.id AS schedule_id, st.name AS task_name,
        st.project_id, p.name AS project_name
      FROM scheduled_runs sr
      JOIN scheduled_tasks st ON st.id = sr.task_id
      LEFT JOIN projects p ON p.id = st.project_id
      WHERE sr.thread_id = ? ORDER BY sr.started_at DESC LIMIT 1
    `).get(threadId);
    if (scheduled) return { ...scheduled, source: "scheduled", title: scheduled.task_name };
    const preferences = this.stores.getThreadPreferences(threadId);
    return {
      source: "chat",
      title: preferences?.name || "Codex 任务",
      project_id: preferences?.projectId || null,
      project_name: null,
    };
  }

  #activeForThread(threadId) {
    return this.stores.db.prepare(`
      SELECT * FROM notifications WHERE thread_id = ? AND status IN ('running', 'waiting')
      ORDER BY updated_at DESC LIMIT 1
    `).get(threadId);
  }

  #upsert(input, { dispatch = true } = {}) {
    const existing = this.stores.db.prepare("SELECT * FROM notifications WHERE event_key = ?").get(input.eventKey);
    const timestamp = now();
    const id = existing?.id || randomUUID();
    const unread = ["completed", "failed", "timeout", "waiting"].includes(input.status) ? 0 : 1;
    this.stores.db.prepare(`
      INSERT INTO notifications (
        id, event_key, status, source, title, message, thread_id, turn_id, project_id,
        schedule_id, schedule_run_id, is_read, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        status = excluded.status, source = excluded.source, title = excluded.title,
        message = excluded.message, thread_id = COALESCE(excluded.thread_id, notifications.thread_id),
        turn_id = COALESCE(excluded.turn_id, notifications.turn_id),
        project_id = COALESCE(excluded.project_id, notifications.project_id),
        schedule_id = COALESCE(excluded.schedule_id, notifications.schedule_id),
        schedule_run_id = COALESCE(excluded.schedule_run_id, notifications.schedule_run_id),
        is_read = CASE WHEN notifications.status = excluded.status THEN notifications.is_read ELSE excluded.is_read END,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.eventKey,
      input.status,
      input.source,
      truncate(input.title, 160) || "Codex 任务",
      truncate(input.message),
      input.threadId || null,
      input.turnId || null,
      input.projectId || null,
      input.scheduleId || null,
      input.scheduleRunId || null,
      unread,
      existing?.created_at || timestamp,
      timestamp,
    );
    this.stores.db.prepare(`
      DELETE FROM notifications WHERE id IN (
        SELECT id FROM notifications ORDER BY updated_at DESC LIMIT -1 OFFSET 2000
      )
    `).run();
    const row = this.stores.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id);
    this.#changed();
    if (dispatch && eventTypes.has(row.status) && existing?.status !== row.status) void this.#dispatch(row);
    return row;
  }

  #changed() {
    this.onChanged(this.summary());
  }

  async #dispatch(row) {
    for (const channel of externalChannels) {
      const config = this.getChannelSecret(channel);
      if (!config?.enabled || !config.events.includes(row.status)) continue;
      const deliveryId = randomUUID();
      const inserted = this.stores.db.prepare(`
        INSERT OR IGNORE INTO notification_deliveries (
          id, notification_id, channel, event_type, status, attempted_at
        ) VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(deliveryId, row.id, channel, row.status, now()).changes > 0;
      if (!inserted) continue;
      try {
        await this.#send(channel, config, row);
        this.stores.db.prepare("UPDATE notification_deliveries SET status = 'succeeded', error = NULL, attempted_at = ? WHERE id = ?")
          .run(now(), deliveryId);
      } catch (error) {
        this.stores.db.prepare("UPDATE notification_deliveries SET status = 'failed', error = ?, attempted_at = ? WHERE id = ?")
          .run(safeError(error), now(), deliveryId);
      }
    }
  }

  #notificationText(row) {
    const status = { completed: "已完成", failed: "失败", timeout: "超时", waiting: "等待输入" }[row.status] || row.status;
    const source = row.source === "scheduled" ? "定时任务" : "聊天任务";
    const lines = [
      `【Codex 飞牛工作台 · ${status}】`,
      `任务：${row.title}`,
      `类型：${source}`,
    ];
    if (row.message) lines.push(`详情：${truncate(row.message, 600)}`);
    lines.push(`时间：${new Date((row.updated_at || now()) * 1000).toLocaleString("zh-CN", { hour12: false })}`);
    return lines.join("\n");
  }

  async #send(channel, config, row) {
    const message = this.#notificationText(row);
    let body;
    let headers = { "content-type": "application/json; charset=utf-8", "user-agent": "codex-fnos-web/0.9.5" };
    if (channel === "hermes") {
      body = JSON.stringify({ message });
      headers = {
        ...headers,
        "X-Webhook-Signature": createHmac("sha256", config.secret).update(body).digest("hex"),
      };
    } else {
      const payload = { msg_type: "text", content: { text: message } };
      if (config.secret) {
        const timestamp = String(now());
        payload.timestamp = timestamp;
        payload.sign = createHmac("sha256", `${timestamp}\n${config.secret}`).update("").digest("base64");
      }
      body = JSON.stringify(payload);
    }
    const response = await this.fetchImpl(config.webhookUrl, {
      agent: isPrivateWebhook(config.webhookUrl) ? undefined : createProviderAgent(this.getProxy()),
      body,
      headers,
      method: "POST",
      signal: AbortSignal.timeout(12_000),
    });
    const responseText = await response.text();
    let result = {};
    try {
      result = JSON.parse(responseText);
    } catch {
      result = {};
    }
    const businessError = channel === "feishu"
      ? (result.code !== undefined && Number(result.code) !== 0) || (result.StatusCode !== undefined && Number(result.StatusCode) !== 0)
      : result.status && !["ok", "delivered"].includes(result.status);
    if (!response.ok || businessError) {
      const messageText = truncate(result.msg || result.StatusMessage || result.message || `HTTP ${response.status}`, 300);
      throw new Error(`${channel === "feishu" ? "飞书" : "Hermes"} 返回失败：${messageText}`);
    }
  }

  #handleBridgeEvent(event) {
    if (event.kind === "server_request") {
      const request = event.request || {};
      if (request.method === "currentTime/read") return;
      const threadId = request.params?.threadId;
      if (!threadId) return;
      const active = this.#activeForThread(threadId);
      const turnId = request.params?.turnId || active?.turn_id || `request-${request.id}`;
      const context = this.#contextForThread(threadId);
      this.pendingRequests.set(String(request.id), { threadId, turnId, eventKey: `turn:${threadId}:${turnId}` });
      this.#upsert({
        eventKey: `turn:${threadId}:${turnId}`,
        status: "waiting",
        source: context.source,
        title: context.title,
        message: "Codex 正在等待审批或补充信息。",
        threadId,
        turnId,
        projectId: context.project_id,
        scheduleId: context.schedule_id,
        scheduleRunId: context.run_id,
      });
      return;
    }
    if (event.kind !== "notification") return;
    const params = event.params || {};
    if (event.method === "serverRequest/resolved") {
      const pending = this.pendingRequests.get(String(params.requestId));
      if (!pending) return;
      this.pendingRequests.delete(String(params.requestId));
      const existing = this.stores.db.prepare("SELECT * FROM notifications WHERE event_key = ?").get(pending.eventKey);
      if (existing?.status === "waiting") this.#upsert({
        eventKey: pending.eventKey,
        status: "running",
        source: existing.source,
        title: existing.title,
        message: "",
        threadId: pending.threadId,
        turnId: pending.turnId,
        projectId: existing.project_id,
        scheduleId: existing.schedule_id,
        scheduleRunId: existing.schedule_run_id,
      }, { dispatch: false });
      return;
    }
    const threadId = params.threadId;
    if (!threadId) return;
    if (event.method === "turn/started") {
      const turnId = params.turn?.id;
      if (!turnId) return;
      const context = this.#contextForThread(threadId);
      this.#upsert({
        eventKey: `turn:${threadId}:${turnId}`,
        status: "running",
        source: context.source,
        title: context.title,
        message: "",
        threadId,
        turnId,
        projectId: context.project_id,
        scheduleId: context.schedule_id,
        scheduleRunId: context.run_id,
      }, { dispatch: false });
      return;
    }
    if (event.method === "error" && !params.willRetry) {
      const active = this.#activeForThread(threadId);
      if (!active) return;
      const message = safeError(params.error);
      this.#upsert({
        eventKey: active.event_key,
        status: looksLikeTimeout(message) ? "timeout" : "failed",
        source: active.source,
        title: active.title,
        message,
        threadId,
        turnId: active.turn_id,
        projectId: active.project_id,
        scheduleId: active.schedule_id,
        scheduleRunId: active.schedule_run_id,
      });
      return;
    }
    if (event.method !== "turn/completed") return;
    const turn = params.turn || {};
    const active = this.#activeForThread(threadId);
    const turnId = turn.id || active?.turn_id;
    if (!turnId) return;
    const context = this.#contextForThread(threadId);
    const error = turn.error?.message || turn.error || "";
    const status = turn.status === "completed" ? "completed" : looksLikeTimeout(error) ? "timeout" : "failed";
    this.#upsert({
      eventKey: `turn:${threadId}:${turnId}`,
      status,
      source: context.source,
      title: context.title,
      message: status === "completed" ? turnOutput(turn) : safeError(error || `任务状态：${turn.status || "unknown"}`),
      threadId,
      turnId,
      projectId: context.project_id,
      scheduleId: context.schedule_id,
      scheduleRunId: context.run_id,
    });
  }
}
