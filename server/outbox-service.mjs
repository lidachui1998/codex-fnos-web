import { randomUUID } from "node:crypto";

const now = () => Math.floor(Date.now() / 1000);
const clientIdFor = (id) => `fnos-outbox-${id}`;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function activeTurn(thread) {
  return [...(thread?.turns ?? [])].reverse().find((turn) => turn?.status === "inProgress") ?? null;
}

function lastCompletedTurn(thread) {
  return [...(thread?.turns ?? [])].reverse().find((turn) => turn?.status === "completed") ?? null;
}

function threadHasClientId(thread, clientId) {
  return (thread?.turns ?? []).some((turn) => (turn.items ?? []).some((item) => item?.clientId === clientId));
}

function publicRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    projectId: row.project_id,
    ...parseJson(row.display_payload_json, { text: "", attachments: [], skills: [] }),
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OutboxService {
  constructor({ stores, bridge, subagentJoins, getAccountId, onChanged = () => {}, retryDelayMs = 5_000 }) {
    this.stores = stores;
    this.bridge = bridge;
    this.subagentJoins = subagentJoins;
    this.getAccountId = getAccountId;
    this.onChanged = onChanged;
    this.retryDelayMs = retryDelayMs;
    this.timers = new Map();
    this.closed = false;
    this.eventHandler = (event) => {
      if (event.kind === "bridge_state" && event.state?.status === "ready") {
        this.kickAll();
        return;
      }
      if (event.kind !== "notification" || event.method !== "turn/completed" || !event.params?.threadId) return;
      const threadId = event.params.threadId;
      const clientIds = new Set((event.params.turn?.items ?? []).map((item) => item?.clientId).filter(Boolean));
      if (clientIds.size > 0) {
        const rows = this.#rowsForThread(threadId).filter((row) => row.status === "dispatching");
        for (const row of rows) {
          if (clientIds.has(clientIdFor(row.id))) this.#delete(row.id);
        }
      }
      this.kick(threadId, 350);
    };
    bridge.on("event", this.eventHandler);
    const timer = setTimeout(() => this.kickAll(), 750);
    timer.unref?.();
  }

  list(threadId = null) {
    const accountId = this.getAccountId();
    const rows = threadId
      ? this.stores.db.prepare(`
          SELECT * FROM queued_messages
          WHERE account_id = ? AND thread_id = ?
          ORDER BY created_at, id
        `).all(accountId, String(threadId))
      : this.stores.db.prepare(`
          SELECT * FROM queued_messages
          WHERE account_id = ?
          ORDER BY created_at, id
        `).all(accountId);
    return rows.map(publicRow);
  }

  enqueue({ threadId, projectId, displayPayload, turnInput, approvalPolicy, networkAccess, model, effort }) {
    const id = randomUUID();
    const timestamp = now();
    this.stores.db.prepare(`
      INSERT INTO queued_messages (
        id, account_id, thread_id, project_id, display_payload_json, turn_input_json,
        approval_policy, network_access, model, reasoning_effort, status,
        attempt_count, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?)
    `).run(
      id,
      this.getAccountId(),
      String(threadId),
      String(projectId),
      JSON.stringify(displayPayload),
      JSON.stringify(turnInput),
      approvalPolicy,
      networkAccess ? 1 : 0,
      model || null,
      effort || null,
      timestamp,
      timestamp,
    );
    this.#notify(threadId);
    this.kick(threadId);
    return this.list(threadId).find((item) => item.id === id);
  }

  remove(id) {
    const row = this.#row(id);
    if (!row) return false;
    if (row.status === "dispatching") throw Object.assign(new Error("消息正在发送，不能取消"), { status: 409 });
    this.#delete(row.id);
    this.#notify(row.thread_id);
    return true;
  }

  removeThread(threadId) {
    const result = this.stores.db.prepare(`
      DELETE FROM queued_messages WHERE account_id = ? AND thread_id = ?
    `).run(this.getAccountId(), String(threadId));
    clearTimeout(this.timers.get(threadId));
    this.timers.delete(threadId);
    if (result.changes > 0) this.#notify(threadId);
    return result.changes;
  }

  retry(id) {
    const row = this.#row(id);
    if (!row) return null;
    if (row.status === "dispatching") throw Object.assign(new Error("消息正在发送"), { status: 409 });
    this.stores.db.prepare(`
      UPDATE queued_messages
      SET status = 'queued', attempt_count = 0, last_error = NULL, updated_at = ?
      WHERE id = ? AND account_id = ?
    `).run(now(), row.id, this.getAccountId());
    this.#notify(row.thread_id);
    this.kick(row.thread_id);
    return this.list(row.thread_id).find((item) => item.id === row.id) ?? null;
  }

  async steer(id, expectedTurnId) {
    const row = this.#claim(id);
    if (!row) throw Object.assign(new Error("消息已被发送、取消或正在由其他页面处理"), { status: 409 });
    try {
      const result = await this.bridge.request("turn/steer", {
        threadId: row.thread_id,
        clientUserMessageId: clientIdFor(row.id),
        input: parseJson(row.turn_input_json, []),
        expectedTurnId,
      });
      this.#delete(row.id);
      this.#notify(row.thread_id);
      return result;
    } catch (error) {
      this.#fail(row, error);
      throw error;
    }
  }

  kick(threadId, delayMs = 80) {
    if (this.closed || !threadId) return;
    clearTimeout(this.timers.get(threadId));
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      void this.#dispatch(threadId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(threadId, timer);
  }

  kickAll() {
    if (this.closed) return;
    const rows = this.stores.db.prepare(`
      SELECT DISTINCT thread_id FROM queued_messages
      WHERE account_id = ? AND status IN ('queued', 'dispatching')
    `).all(this.getAccountId());
    for (const row of rows) this.kick(row.thread_id);
  }

  close() {
    this.closed = true;
    this.bridge.off("event", this.eventHandler);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async #dispatch(threadId) {
    if (this.closed || this.bridge.snapshot().status !== "ready") return;
    let thread;
    try {
      thread = (await this.bridge.request("thread/read", { threadId, includeTurns: true })).thread;
    } catch (error) {
      this.#failOldest(threadId, error);
      return;
    }
    const dispatching = this.#rowsForThread(threadId).find((row) => row.status === "dispatching");
    if (dispatching) {
      if (threadHasClientId(thread, clientIdFor(dispatching.id))) {
        this.#delete(dispatching.id);
        this.#notify(threadId);
      } else if (!activeTurn(thread)) {
        this.stores.db.prepare(`
          UPDATE queued_messages SET status = 'queued', updated_at = ?
          WHERE id = ? AND account_id = ? AND status = 'dispatching'
        `).run(now(), dispatching.id, this.getAccountId());
      } else {
        return;
      }
    }
    if (activeTurn(thread)) return;
    await this.subagentJoins?.ensure(threadId, lastCompletedTurn(thread)?.id ?? null);
    if (this.subagentJoins?.snapshot(threadId)) return;
    try {
      thread = (await this.bridge.request("thread/read", { threadId, includeTurns: true })).thread;
    } catch (error) {
      this.#failOldest(threadId, error);
      return;
    }
    if (activeTurn(thread)) return;
    const row = this.#claimOldest(threadId);
    if (!row) return;
    const project = this.stores.listProjects().find((item) => item.id === row.project_id);
    if (!project) {
      this.#fail(row, new Error("等待消息所属项目已被移除"), true);
      return;
    }
    try {
      await this.bridge.request("turn/start", {
        threadId: row.thread_id,
        clientUserMessageId: clientIdFor(row.id),
        input: parseJson(row.turn_input_json, []),
        approvalPolicy: row.approval_policy,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [project.path],
          networkAccess: Boolean(row.network_access),
        },
        model: row.model || undefined,
        effort: row.reasoning_effort || undefined,
      });
      this.stores.saveThreadApprovalPolicy(row.thread_id, row.approval_policy);
      this.stores.saveThreadNetworkAccess(row.thread_id, Boolean(row.network_access));
      this.#delete(row.id);
      this.#notify(row.thread_id);
    } catch (error) {
      this.#fail(row, error);
    }
  }

  #row(id) {
    return this.stores.db.prepare("SELECT * FROM queued_messages WHERE id = ? AND account_id = ?")
      .get(String(id), this.getAccountId());
  }

  #rowsForThread(threadId) {
    return this.stores.db.prepare(`
      SELECT * FROM queued_messages WHERE account_id = ? AND thread_id = ? ORDER BY created_at, id
    `).all(this.getAccountId(), String(threadId));
  }

  #claim(id) {
    const result = this.stores.db.prepare(`
      UPDATE queued_messages SET status = 'dispatching', updated_at = ?
      WHERE id = ? AND account_id = ? AND status IN ('queued', 'failed')
    `).run(now(), String(id), this.getAccountId());
    return result.changes > 0 ? this.#row(id) : null;
  }

  #claimOldest(threadId) {
    const row = this.#rowsForThread(threadId).find((item) => item.status === "queued");
    return row ? this.#claim(row.id) : null;
  }

  #failOldest(threadId, error) {
    const row = this.#rowsForThread(threadId).find((item) => item.status === "queued" || item.status === "dispatching");
    if (row) this.#fail(row, error);
  }

  #fail(row, error, terminal = false) {
    const attemptCount = Number(row.attempt_count || 0) + 1;
    const status = terminal || attemptCount >= 3 ? "failed" : "queued";
    this.stores.db.prepare(`
      UPDATE queued_messages
      SET status = ?, attempt_count = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND account_id = ?
    `).run(status, attemptCount, String(error?.message || error || "发送失败").slice(0, 1000), now(), row.id, this.getAccountId());
    this.#notify(row.thread_id);
    if (status === "queued") this.kick(row.thread_id, this.retryDelayMs);
  }

  #delete(id) {
    return this.stores.db.prepare("DELETE FROM queued_messages WHERE id = ? AND account_id = ?")
      .run(String(id), this.getAccountId()).changes > 0;
  }

  #notify(threadId) {
    this.onChanged({ threadId, count: this.list(threadId).length });
  }
}
