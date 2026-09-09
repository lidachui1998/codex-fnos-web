export class RuntimeService {
  constructor(bridge, { retryDelays = [2000, 5000, 15000], stableMs = 60000 } = {}) {
    this.bridge = bridge;
    this.retryDelays = retryDelays;
    this.stableMs = stableMs;
    this.attempts = 0;
    this.nextRetryAt = null;
    this.closed = false;
    this.onEvent = (event) => {
      if (event.kind !== "bridge_state") return;
      clearTimeout(this.retryTimer);
      clearTimeout(this.stableTimer);
      this.nextRetryAt = null;
      if (event.state.status === "ready") {
        this.stableTimer = setTimeout(() => { this.attempts = 0; }, this.stableMs);
        this.stableTimer.unref?.();
      } else if (event.state.status === "error") this.queueRecovery();
    };
    bridge.on("event", this.onEvent);
  }

  snapshot() {
    return { bridge: this.bridge.snapshot(), activeTurns: this.bridge.activeTurns?.size ?? 0,
      recoveryAttempts: this.attempts, nextRetryAt: this.nextRetryAt };
  }

  queueRecovery() {
    if (this.closed || this.attempts >= this.retryDelays.length) return;
    const delay = this.retryDelays[this.attempts];
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(async () => {
      this.nextRetryAt = null;
      if (this.closed || this.bridge.snapshot().status !== "error") return;
      this.attempts += 1;
      try { await this.bridge.restart(); }
      catch { /* The bridge error event schedules the next bounded attempt. */ }
    }, delay);
    this.retryTimer.unref?.();
  }

  async restart({ force = false } = {}) {
    if (this.bridge.hasActiveTurns() && !force) {
      throw Object.assign(new Error("仍有对话或子代理正在运行，重启会中断这些任务"), { status: 409 });
    }
    clearTimeout(this.retryTimer);
    this.nextRetryAt = null;
    this.attempts = 0;
    await this.bridge.restart();
    return this.snapshot();
  }

  async mcpStatus(threadId) {
    const servers = [];
    let cursor;
    // MCP inventory includes secrets in some tool schemas; return only display fields.
    for (let page = 0; page < 20; page += 1) {
      const result = await this.bridge.request("mcpServerStatus/list", {
        limit: 100, ...(cursor ? { cursor } : {}), ...(threadId ? { threadId } : {}),
      }, { timeoutMs: 20000 });
      for (const server of result.data ?? []) {
        servers.push({ name: server.name, authStatus: server.authStatus,
          tools: Object.values(server.tools ?? {}).map((tool) => tool.name).filter(Boolean).slice(0, 100),
          resourceCount: server.resources?.length ?? 0, templateCount: server.resourceTemplates?.length ?? 0 });
      }
      if (!result.nextCursor) return { data: servers, truncated: false };
      if (cursor === result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return { data: servers, truncated: true };
  }

  async reloadMcp() {
    await this.bridge.request("config/mcpServer/reload", {}, { timeoutMs: 20000 });
    return { message: "MCP 配置已重载，已打开的会话将在下一轮重新连接。" };
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
    this.bridge.off("event", this.onEvent);
  }
}
