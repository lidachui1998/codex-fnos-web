import { randomUUID } from "node:crypto";
import { composeDeveloperInstructions } from "./instructions.mjs";

export const automaticJoinClientIdPrefix = "fnos-subagent-join-";

function statusType(thread) {
  return typeof thread?.status === "string" ? thread.status : thread?.status?.type;
}

function activeDescendants(threads) {
  return (threads ?? []).filter((thread) => statusType(thread) === "active");
}

export class SubagentJoinService {
  constructor({ stores, bridge, onChanged = () => {}, pollIntervalMs = 1_200, settleDelayMs = 120 }) {
    this.stores = stores;
    this.bridge = bridge;
    this.onChanged = onChanged;
    this.pollIntervalMs = pollIntervalMs;
    this.settleDelayMs = settleDelayMs;
    this.pending = new Map();
    this.closed = false;
    this.eventHandler = (event) => {
      if (event.kind !== "notification" || event.method !== "turn/completed") return;
      if (event.params?.turn?.status !== "completed" || !event.params?.threadId) return;
      void this.ensure(event.params.threadId, event.params.turn.id);
    };
    bridge.on("event", this.eventHandler);
  }

  snapshot(threadId) {
    const state = this.pending.get(threadId);
    if (!state) return null;
    return {
      status: state.status,
      activeCount: state.activeCount,
      rootTurnId: state.rootTurnId,
      startedAt: state.startedAt,
      error: state.error ?? null,
    };
  }

  async ensure(threadId, rootTurnId = null) {
    if (this.closed || this.pending.has(threadId)) return this.snapshot(threadId);
    const state = {
      status: "checking",
      activeCount: 0,
      rootTurnId: rootTurnId || null,
      startedAt: Date.now(),
      error: null,
      timer: null,
    };
    this.pending.set(threadId, state);
    if (this.settleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.settleDelayMs));
    await this.#evaluate(threadId, state);
    return this.snapshot(threadId);
  }

  close() {
    this.closed = true;
    this.bridge.off("event", this.eventHandler);
    for (const state of this.pending.values()) clearTimeout(state.timer);
    this.pending.clear();
  }

  async #evaluate(threadId, state) {
    if (this.closed || this.pending.get(threadId) !== state) return;
    try {
      const result = await this.bridge.request("thread/list", {
        limit: 100,
        archived: false,
        ancestorThreadId: threadId,
        modelProviders: [],
      });
      const active = activeDescendants(result.data);
      if (active.length === 0) {
        if (state.status === "checking") {
          this.pending.delete(threadId);
          return;
        }
        await this.#resumeParent(threadId, state, result.data ?? []);
        return;
      }
      state.status = "waiting";
      state.activeCount = active.length;
      state.error = null;
      this.#notify(threadId, state);
      this.#schedule(threadId, state);
    } catch (error) {
      state.status = "waiting";
      state.error = error.message || "无法读取子代理状态";
      this.#notify(threadId, state);
      this.#schedule(threadId, state);
    }
  }

  #schedule(threadId, state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.#evaluate(threadId, state), this.pollIntervalMs);
    state.timer.unref?.();
  }

  async #resumeParent(threadId, state, descendants) {
    state.status = "finalizing";
    state.activeCount = 0;
    state.error = null;
    this.#notify(threadId, state);
    try {
      const preferences = this.stores.getThreadPreferences(threadId);
      const project = preferences?.projectId
        ? this.stores.listProjects().find((item) => item.id === preferences.projectId)
        : null;
      const resumed = await this.bridge.request("thread/resume", {
        threadId,
        developerInstructions: composeDeveloperInstructions(this.stores.getSettings(), project?.instructions),
      });
      if (statusType(resumed.thread) === "active") {
        this.pending.delete(threadId);
        this.onChanged({ threadId, status: "resumed", activeCount: 0, rootTurnId: state.rootTurnId, turnId: null });
        return;
      }
      const cwd = project?.path || resumed.thread?.cwd;
      const networkAccess = preferences?.networkAccess ?? this.stores.getSettings().networkAccess;
      const approvalPolicy = preferences?.approvalPolicy ?? this.stores.getSettings().approvalPolicy;
      const result = await this.bridge.request("turn/start", {
        threadId,
        clientUserMessageId: `${automaticJoinClientIdPrefix}${state.rootTurnId || randomUUID()}`,
        input: [{
          type: "text",
          text: `所有 ${descendants.length} 个直接或嵌套子代理现已退出运行状态。请读取并汇总它们的真实结果，继续完成用户原始任务；若有失败或未完成项请明确说明。不要仅报告“子代理已结束”。`,
        }],
        approvalPolicy,
        ...(cwd ? { sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess } } : {}),
      });
      this.pending.delete(threadId);
      this.onChanged({ threadId, status: "resumed", activeCount: 0, rootTurnId: state.rootTurnId, turnId: result.turn?.id ?? null });
    } catch (error) {
      this.pending.delete(threadId);
      this.onChanged({
        threadId,
        status: "failed",
        activeCount: 0,
        rootTurnId: state.rootTurnId,
        turnId: null,
        error: error.message || "主任务自动收口失败",
      });
    }
  }

  #notify(threadId, state) {
    this.onChanged({
      threadId,
      status: state.status,
      activeCount: state.activeCount,
      rootTurnId: state.rootTurnId,
      error: state.error,
    });
  }
}
