import { randomUUID } from "node:crypto";
import { codexRuntimeConfig, modelProviderKey } from "./app-server-bridge.mjs";
import { prepareDesktopAutomationImport } from "./automation-import.mjs";
import { composeDeveloperInstructions } from "./instructions.mjs";
import { computeNextRun, normalizeSchedule } from "./schedule-rules.mjs";

export { computeNextRun, normalizeSchedule } from "./schedule-rules.mjs";

const now = () => Math.floor(Date.now() / 1000);

function publicTask(row, projectName, runs = []) {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    projectName,
    prompt: row.prompt,
    schedule: JSON.parse(row.schedule_json),
    enabled: Boolean(row.enabled),
    networkAccess: Boolean(row.network_access),
    sandboxMode: row.sandbox_mode === "unrestricted" ? "unrestricted" : "workspace",
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sourceAutomationId: row.source_automation_id,
    sourceCwd: row.source_cwd,
    sourcePrompt: row.source_prompt,
    memoryBytes: Buffer.byteLength(String(row.memory_text || ""), "utf8"),
    compatibility: JSON.parse(row.compatibility_json || "[]"),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runs: runs.map((run) => ({
      id: run.id,
      threadId: run.thread_id,
      turnId: run.turn_id,
      status: run.status,
      output: run.output,
      error: run.error,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    })),
  };
}

function turnOutput(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const item = [...items].reverse().find((entry) => ["agentMessage", "plan"].includes(entry?.type) && String(entry.text || "").trim());
  return String(item?.text || "").trim().slice(0, 20_000) || null;
}

export class ScheduleService {
  constructor({ stores, bridge, notifications = null, subagentJoins = null, onChanged = () => {} }) {
    this.stores = stores;
    this.bridge = bridge;
    this.notifications = notifications;
    this.subagentJoins = subagentJoins;
    this.onChanged = onChanged;
    this.ticking = false;
    this.stores.db.prepare(`
      UPDATE scheduled_runs SET status = 'failed', error = ?, completed_at = ? WHERE status = 'running'
    `).run("应用服务在任务完成前重启", now());
    this.eventHandler = (event) => this.#handleBridgeEvent(event);
    bridge.on("event", this.eventHandler);
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
    this.bridge.off("event", this.eventHandler);
  }

  list() {
    const projects = new Map(this.stores.listProjects().map((project) => [project.id, project.name]));
    return this.stores.db.prepare("SELECT * FROM scheduled_tasks ORDER BY updated_at DESC").all().map((row) => {
      const runs = this.stores.db.prepare("SELECT * FROM scheduled_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 8").all(row.id);
      return publicTask(row, projects.get(row.project_id) || "项目已移除", runs);
    });
  }

  previewDesktopImport(input) {
    const project = this.stores.listProjects().find((item) => item.id === String(input.projectId || ""));
    return prepareDesktopAutomationImport(input, project).preview;
  }

  importDesktop(input) {
    const project = this.stores.listProjects().find((item) => item.id === String(input.projectId || ""));
    const prepared = prepareDesktopAutomationImport(input, project);
    const sourceId = prepared.task.sourceAutomationId;
    const existing = sourceId
      ? this.stores.db.prepare("SELECT id FROM scheduled_tasks WHERE source_automation_id = ? LIMIT 1").get(sourceId)
      : null;
    return {
      task: this.save(prepared.task, existing?.id || randomUUID()),
      preview: prepared.preview,
      replacedExisting: Boolean(existing),
    };
  }

  save(input, id = randomUUID()) {
    const existing = this.stores.db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
    const projectId = String(input.projectId ?? existing?.project_id ?? "");
    if (!this.stores.listProjects().some((project) => project.id === projectId)) {
      throw Object.assign(new Error("定时任务所属项目不存在"), { status: 404 });
    }
    const name = String(input.name ?? existing?.name ?? "").trim().slice(0, 120);
    const prompt = String(input.prompt ?? existing?.prompt ?? "").trim();
    if (!name) throw Object.assign(new Error("定时任务名称不能为空"), { status: 400 });
    if (!prompt) throw Object.assign(new Error("定时任务内容不能为空"), { status: 400 });
    if (prompt.length > 20_000) throw Object.assign(new Error("定时任务内容不能超过 20000 个字符"), { status: 400 });
    const schedule = normalizeSchedule(input.schedule ?? JSON.parse(existing?.schedule_json || "null"));
    const enabled = input.enabled ?? Boolean(existing?.enabled ?? true);
    const sandboxMode = String(input.sandboxMode ?? existing?.sandbox_mode ?? "workspace");
    if (!["workspace", "unrestricted"].includes(sandboxMode)) {
      throw Object.assign(new Error("定时任务沙箱模式无效"), { status: 400 });
    }
    const model = Object.hasOwn(input, "model") ? String(input.model || "").trim().slice(0, 120) || null : existing?.model ?? null;
    const reasoningEffort = Object.hasOwn(input, "reasoningEffort") ? String(input.reasoningEffort || "").trim() || null : existing?.reasoning_effort ?? null;
    if (reasoningEffort && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoningEffort)) {
      throw Object.assign(new Error("定时任务思考强度无效"), { status: 400 });
    }
    const sourceAutomationId = Object.hasOwn(input, "sourceAutomationId") ? input.sourceAutomationId : existing?.source_automation_id ?? null;
    const sourceCwd = Object.hasOwn(input, "sourceCwd") ? input.sourceCwd : existing?.source_cwd ?? null;
    const sourcePrompt = Object.hasOwn(input, "sourcePrompt") ? input.sourcePrompt : existing?.source_prompt ?? null;
    const memoryText = Object.hasOwn(input, "memory") ? String(input.memory || "") : existing?.memory_text ?? null;
    let compatibility = Object.hasOwn(input, "compatibility")
      ? input.compatibility || []
      : JSON.parse(existing?.compatibility_json || "[]");
    if (input.resolveCompatibility === true) {
      compatibility = compatibility.map((issue) => issue.severity === "blocker"
        ? { ...issue, severity: "warning", resolved: true, message: `已确认完成 fnOS 适配：${issue.message}` }
        : issue);
    }
    if (enabled && compatibility.some((issue) => issue.severity === "blocker")) {
      throw Object.assign(new Error("任务仍有 fnOS 兼容阻塞；请先编辑任务、完成适配并勾选确认后再启用"), { status: 409 });
    }
    const compatibilityJson = JSON.stringify(compatibility);
    const timestamp = now();
    const nextRunAt = enabled ? computeNextRun(schedule) : null;
    this.stores.db.prepare(`
      INSERT INTO scheduled_tasks (
        id, name, project_id, prompt, schedule_json, enabled, network_access, sandbox_mode,
        model, reasoning_effort, source_automation_id, source_cwd, source_prompt, memory_text, compatibility_json,
        next_run_at, last_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, project_id = excluded.project_id, prompt = excluded.prompt,
        schedule_json = excluded.schedule_json, enabled = excluded.enabled, network_access = 1,
        sandbox_mode = excluded.sandbox_mode,
        model = excluded.model, reasoning_effort = excluded.reasoning_effort,
        source_automation_id = excluded.source_automation_id, source_cwd = excluded.source_cwd,
        source_prompt = excluded.source_prompt, memory_text = excluded.memory_text,
        compatibility_json = excluded.compatibility_json,
        next_run_at = excluded.next_run_at, updated_at = excluded.updated_at
    `).run(
      id,
      name,
      projectId,
      prompt,
      JSON.stringify(schedule),
      enabled ? 1 : 0,
      sandboxMode,
      model,
      reasoningEffort,
      sourceAutomationId,
      sourceCwd,
      sourcePrompt,
      memoryText,
      compatibilityJson,
      nextRunAt,
      existing?.last_run_at ?? null,
      existing?.created_at ?? timestamp,
      timestamp,
    );
    this.onChanged();
    return this.list().find((task) => task.id === id);
  }

  delete(id) {
    const deleted = this.stores.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id).changes > 0;
    if (deleted) this.onChanged();
    return deleted;
  }

  async runNow(id) {
    const task = this.stores.db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
    if (!task) throw Object.assign(new Error("定时任务不存在"), { status: 404 });
    if (this.stores.db.prepare("SELECT 1 FROM scheduled_runs WHERE task_id = ? AND status = 'running'").get(id)) {
      throw Object.assign(new Error("这个定时任务正在执行"), { status: 409 });
    }
    this.stores.db.prepare("UPDATE scheduled_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
    return this.#startRun(task);
  }

  async tick() {
    if (this.ticking || this.bridge.snapshot().status !== "ready") return;
    this.ticking = true;
    try {
      const due = this.stores.db.prepare(`
        SELECT * FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC LIMIT 4
      `).all(now());
      for (const task of due) {
        const timestamp = now();
        const nextRunAt = computeNextRun(JSON.parse(task.schedule_json), new Date());
        this.stores.db.prepare("UPDATE scheduled_tasks SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?")
          .run(nextRunAt, timestamp, timestamp, task.id);
        try {
          await this.#startRun(task);
        } catch {
          // The failed run is persisted by #startRun; continue with other due tasks.
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  async #startRun(task) {
    if (this.bridge.snapshot().status !== "ready") throw Object.assign(new Error("Codex 服务尚未就绪"), { status: 503 });
    const project = this.stores.listProjects().find((item) => item.id === task.project_id);
    if (!project) throw Object.assign(new Error("定时任务所属项目已移除"), { status: 404 });
    const providerId = project.defaultProviderId || null;
    const provider = providerId ? this.stores.listProviders().find((item) => item.id === providerId) : null;
    const unattendedAccess = Boolean(task.network_access);
    const unrestrictedAccess = unattendedAccess && task.sandbox_mode === "unrestricted";
    const unattendedInstructions = !unattendedAccess
      ? "这是升级前创建且尚未重新保存的旧定时任务。保持只读且不联网，不要修改文件、配置或服务，不要安装软件；如果任务需要这些能力，只在结果中说明需要重新保存任务以启用完整权限。"
      : unrestrictedAccess
        ? "这是用户明确允许关闭 Codex 内置沙箱的后台自动审批任务，以便浏览器、渲染器、编码器和其他长生命周期子进程正常工作；实际系统权限仍受 fnOS 应用运行账号约束。不要请求人工确认。只允许在当前项目目录内读取、创建、修改、移动、覆盖或删除文件，可以安装项目依赖，可以访问任意互联网地址，并可以按任务要求向外部发送或上传当前项目中的内容。不得主动操作项目目录外的文件、飞牛系统配置、存储卷、其他应用或其他项目。完成后检查命令退出码、子进程退出状态和实际产物，并在会话中清楚记录改动与验证。"
        : "这是后台触发的项目沙箱自动审批任务。不要请求人工确认。可以在当前项目目录内读取、创建、修改、移动、覆盖或删除文件，可以安装项目依赖并访问任意互联网地址。不得操作项目目录外的文件。如果浏览器、渲染器或编码器仍被 Codex 沙箱阻止，请在结果中明确说明，需要由用户编辑此任务并主动启用“关闭 Codex 内置沙箱”。";
    const importedMemory = String(task.memory_text || "").trim();
    const memoryContext = importedMemory ? importedMemory.slice(-16_000) : "";
    const runId = randomUUID();
    this.stores.db.prepare(`
      INSERT INTO scheduled_runs (id, task_id, status, started_at) VALUES (?, ?, 'running', ?)
    `).run(runId, task.id, now());
    try {
      const started = await this.bridge.request("thread/start", {
        cwd: project.path,
        modelProvider: modelProviderKey(providerId),
        model: provider?.model || task.model || undefined,
        config: codexRuntimeConfig(task.reasoning_effort || undefined),
        approvalPolicy: "never",
        sandbox: unrestrictedAccess ? "danger-full-access" : unattendedAccess ? "workspace-write" : "read-only",
        developerInstructions: `${composeDeveloperInstructions(this.stores.getSettings(), project.instructions)}

## 无人值守定时运行约束

${unattendedInstructions}

## 长生命周期命令约束

渲染、浏览器、编码、安装和测试等可能超过两分钟的命令，必须使用可持续运行的 unified exec 会话：首次调用只启动一次，命令仍在运行时持续轮询同一个进程或会话直到取得真实退出码。不得用短超时的一次性 shell 包裹长命令，不得因为一次轮询尚未结束就启动重复任务，也不得在未收到用户中断时主动发送 SIGTERM。只有进程真实退出后才能依据退出码和产物做成功或失败判断。${memoryContext ? `

## 从电脑 Codex 导入的任务记忆（仅注入末尾 16000 字符）

${memoryContext}` : ""}`,
        personality: "friendly",
        serviceName: "codex_fnos_schedule",
        threadSource: "automation",
      });
      const threadId = started.thread.id;
      this.stores.saveThreadDisplayName(threadId, `定时：${task.name}`);
      this.stores.saveThreadApprovalPolicy(threadId, "never");
      this.stores.saveThreadNetworkAccess(threadId, unattendedAccess);
      this.stores.saveThreadProjectId(threadId, project.id);
      this.stores.db.prepare("UPDATE scheduled_runs SET thread_id = ? WHERE id = ?").run(threadId, runId);
      const turn = await this.bridge.request("turn/start", {
        threadId,
        clientUserMessageId: `schedule-${runId}`,
        input: [{ type: "text", text: task.prompt }],
        approvalPolicy: "never",
        sandboxPolicy: unrestrictedAccess
          ? { type: "dangerFullAccess" }
          : unattendedAccess
            ? { type: "workspaceWrite", writableRoots: [project.path], networkAccess: true }
          : { type: "readOnly" },
        model: provider?.model || task.model || undefined,
        effort: task.reasoning_effort || undefined,
      });
      this.stores.db.prepare("UPDATE scheduled_runs SET turn_id = ? WHERE id = ?").run(turn.turn.id, runId);
      this.onChanged();
      return { runId, threadId, turnId: turn.turn.id };
    } catch (error) {
      this.stores.db.prepare(`
        UPDATE scheduled_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
      `).run(error.message || "任务启动失败", now(), runId);
      this.notifications?.recordScheduledFailure(runId, error);
      this.onChanged();
      throw error;
    }
  }

  #handleBridgeEvent(event, allowJoinDelay = true) {
    if (event.kind !== "notification") return;
    const threadId = event.params?.threadId;
    if (!threadId) return;
    const run = this.stores.db.prepare("SELECT * FROM scheduled_runs WHERE thread_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1").get(threadId);
    if (!run) return;
    if (event.method === "error" && !event.params?.willRetry) {
      this.stores.db.prepare("UPDATE scheduled_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?")
        .run(String(event.params?.error?.message || event.params?.error || "定时任务执行失败"), now(), run.id);
      this.onChanged();
      return;
    }
    if (event.method !== "turn/completed") return;
    if (allowJoinDelay && this.subagentJoins) {
      const timer = setTimeout(() => {
        if (!this.subagentJoins.snapshot(threadId)) this.#handleBridgeEvent(event, false);
      }, 250);
      timer.unref?.();
      return;
    }
    const turn = event.params?.turn || {};
    const succeeded = turn.status === "completed";
    this.stores.db.prepare(`
      UPDATE scheduled_runs SET status = ?, output = ?, error = ?, completed_at = ? WHERE id = ?
    `).run(
      succeeded ? "succeeded" : "failed",
      turnOutput(turn),
      succeeded ? null : String(turn.error?.message || turn.error || `任务状态：${turn.status || "unknown"}`),
      now(),
      run.id,
    );
    const memory = this.stores.db.prepare("SELECT memory_text FROM scheduled_tasks WHERE id = ?").get(run.task_id)?.memory_text;
    if (memory !== null && memory !== undefined) {
      const summary = succeeded ? turnOutput(turn) || "任务已完成" : String(turn.error?.message || turn.error || turn.status || "任务失败");
      const entry = `\n\n## fnOS 运行记录 ${new Date().toISOString()}\n\n- 状态：${succeeded ? "成功" : "失败"}\n- 摘要：${summary.slice(0, 4_000)}\n`;
      const updated = `${memory}${entry}`;
      const bounded = updated.length <= 512_000 ? updated : `${updated.slice(0, 4_000)}\n\n[较早记录已截断]\n\n${updated.slice(-500_000)}`;
      this.stores.db.prepare("UPDATE scheduled_tasks SET memory_text = ?, updated_at = ? WHERE id = ?").run(bounded, now(), run.task_id);
    }
    this.onChanged();
  }
}
