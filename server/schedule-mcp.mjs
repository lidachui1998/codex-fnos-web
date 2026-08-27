import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { computeNextRun, normalizeSchedule } from "./schedule-rules.mjs";
import { GlobalExtensionService } from "./global-extension-service.mjs";

const now = () => Math.floor(Date.now() / 1000);

function normalizeProjectPath(value) {
  return String(value || "").trim().replace(/[/\\]+$/, "");
}

function publicTask(row) {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    projectName: row.project_name,
    projectPath: row.project_path,
    prompt: row.prompt,
    schedule: JSON.parse(row.schedule_json),
    enabled: Boolean(row.enabled),
    networkAccess: Boolean(row.network_access),
    sandboxMode: row.sandbox_mode === "unrestricted" ? "unrestricted" : "workspace",
    providerMode: ["openai", "provider"].includes(row.provider_mode) ? row.provider_mode : "follow",
    providerId: row.provider_id,
    providerName: row.provider_mode === "openai" ? "OpenAI / ChatGPT" : row.provider_name,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizedModel(value) {
  return String(value || "").trim().slice(0, 120) || null;
}

function normalizedReasoningEffort(value) {
  const effort = String(value || "").trim() || null;
  if (effort && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
    throw new Error("思考强度无效");
  }
  return effort;
}

export class ScheduleToolStore {
  constructor(databasePath) {
    if (!databasePath) throw new Error("FNOS_SCHEDULE_DB 未配置");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  close() {
    this.db.close();
  }

  #project(projectPath) {
    const projects = this.db.prepare("SELECT id, name, path FROM projects ORDER BY updated_at DESC").all();
    const requested = normalizeProjectPath(projectPath);
    if (requested) {
      const project = projects.find((item) => normalizeProjectPath(item.path) === requested);
      if (project) return project;
      throw new Error(`未找到项目目录：${requested}`);
    }
    if (projects.length === 1) return projects[0];
    throw new Error(`存在多个项目，请传入当前项目绝对路径 projectPath。可选：${projects.map((item) => item.path).join("、")}`);
  }

  #providerSelection(value, existingMode = "follow", existingId = null) {
    if (value === undefined) return { mode: existingMode || "follow", id: existingId || null };
    const requested = String(value || "follow").trim();
    if (!requested || requested === "follow") return { mode: "follow", id: null };
    if (requested === "openai") return { mode: "openai", id: null };
    const provider = this.db.prepare("SELECT id FROM provider_profiles WHERE id = ? AND enabled = 1").get(requested);
    if (!provider) throw new Error(`供应商不存在或已停用：${requested}`);
    return { mode: "provider", id: provider.id };
  }

  #task(id) {
    const row = this.db.prepare(`
      SELECT task.*, project.name AS project_name, project.path AS project_path,
        provider.name AS provider_name
      FROM scheduled_tasks task
      JOIN projects project ON project.id = task.project_id
      LEFT JOIN provider_profiles provider ON provider.id = task.provider_id
      WHERE task.id = ?
    `).get(String(id || ""));
    if (!row) throw new Error(`定时任务不存在：${id || ""}`);
    return row;
  }

  list(projectPath = "") {
    const requested = normalizeProjectPath(projectPath);
    const rows = requested
      ? this.db.prepare(`
          SELECT task.*, project.name AS project_name, project.path AS project_path,
            provider.name AS provider_name
          FROM scheduled_tasks task JOIN projects project ON project.id = task.project_id
          LEFT JOIN provider_profiles provider ON provider.id = task.provider_id
          WHERE project.path = ? ORDER BY task.updated_at DESC
        `).all(requested)
      : this.db.prepare(`
          SELECT task.*, project.name AS project_name, project.path AS project_path,
            provider.name AS provider_name
          FROM scheduled_tasks task JOIN projects project ON project.id = task.project_id
          LEFT JOIN provider_profiles provider ON provider.id = task.provider_id
          ORDER BY task.updated_at DESC
        `).all();
    return rows.map(publicTask);
  }

  create(input) {
    const project = this.#project(input.projectPath);
    const name = String(input.name || "").trim().slice(0, 120);
    const prompt = String(input.prompt || "").trim();
    if (!name) throw new Error("任务名称不能为空");
    if (!prompt) throw new Error("任务内容不能为空");
    if (prompt.length > 20_000) throw new Error("任务内容不能超过 20000 个字符");
    const schedule = normalizeSchedule(input.schedule);
    const enabled = input.enabled !== false;
    const sandboxMode = String(input.sandboxMode || "workspace");
    if (!["workspace", "unrestricted"].includes(sandboxMode)) throw new Error("定时任务沙箱模式无效");
    const provider = this.#providerSelection(input.providerId);
    const model = normalizedModel(input.model);
    const reasoningEffort = normalizedReasoningEffort(input.reasoningEffort);
    const timestamp = now();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO scheduled_tasks (
        id, name, project_id, prompt, schedule_json, enabled, network_access, sandbox_mode,
        provider_mode, provider_id, model, reasoning_effort,
        next_run_at, last_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      name,
      project.id,
      prompt,
      JSON.stringify(schedule),
      enabled ? 1 : 0,
      sandboxMode,
      provider.mode,
      provider.id,
      model,
      reasoningEffort,
      enabled ? computeNextRun(schedule) : null,
      timestamp,
      timestamp,
    );
    return this.list(project.path).find((task) => task.id === id);
  }

  update(id, input) {
    const existing = this.#task(id);
    const project = Object.hasOwn(input, "projectPath") ? this.#project(input.projectPath) : {
      id: existing.project_id,
      name: existing.project_name,
      path: existing.project_path,
    };
    const name = String(input.name ?? existing.name).trim().slice(0, 120);
    const prompt = String(input.prompt ?? existing.prompt).trim();
    if (!name) throw new Error("任务名称不能为空");
    if (!prompt) throw new Error("任务内容不能为空");
    if (prompt.length > 20_000) throw new Error("任务内容不能超过 20000 个字符");
    const schedule = Object.hasOwn(input, "schedule") ? normalizeSchedule(input.schedule) : JSON.parse(existing.schedule_json);
    const enabled = Object.hasOwn(input, "enabled") ? Boolean(input.enabled) : Boolean(existing.enabled);
    const sandboxMode = String(input.sandboxMode ?? existing.sandbox_mode ?? "workspace");
    if (!["workspace", "unrestricted"].includes(sandboxMode)) throw new Error("定时任务沙箱模式无效");
    const provider = this.#providerSelection(input.providerId, existing.provider_mode, existing.provider_id);
    const model = Object.hasOwn(input, "model") ? normalizedModel(input.model) : existing.model;
    const reasoningEffort = Object.hasOwn(input, "reasoningEffort")
      ? normalizedReasoningEffort(input.reasoningEffort)
      : existing.reasoning_effort;
    const timestamp = now();
    this.db.prepare(`
      UPDATE scheduled_tasks SET
        name = ?, project_id = ?, prompt = ?, schedule_json = ?, enabled = ?, network_access = 1,
        sandbox_mode = ?, provider_mode = ?, provider_id = ?, model = ?, reasoning_effort = ?,
        next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      name,
      project.id,
      prompt,
      JSON.stringify(schedule),
      enabled ? 1 : 0,
      sandboxMode,
      provider.mode,
      provider.id,
      model,
      reasoningEffort,
      enabled ? computeNextRun(schedule) : null,
      timestamp,
      existing.id,
    );
    return publicTask(this.#task(existing.id));
  }

  delete(id) {
    const existing = this.#task(id);
    this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(existing.id);
    return { deleted: true, id: existing.id, name: existing.name };
  }
}

export class ConversationClient {
  constructor(baseUrl, token) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.token = String(token || "");
  }

  async create(input) {
    if (!this.baseUrl || !this.token) throw new Error("工作台内部新会话入口未配置");
    const response = await fetch(`${this.baseUrl}/internal/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || body.message || `新会话创建失败（HTTP ${response.status}）`);
    return body;
  }
}

const scheduleInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["interval", "daily", "weekly"] },
    minutes: { type: "integer", minimum: 5, maximum: 10080, description: "interval 使用" },
    time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "daily/weekly 使用，NAS 本地时间 HH:mm" },
    days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "weekly 使用，0=周日，1=周一，...，6=周六" },
  },
  required: ["type"],
};

const taskOptionProperties = {
  providerId: { type: "string", description: "模型供应商：follow 表示跟随项目默认，openai 表示官方 OpenAI/ChatGPT，也可传已启用的第三方供应商 ID" },
  model: { type: "string", maxLength: 120, description: "可选模型 ID；空字符串表示使用所选供应商的默认模型" },
  reasoningEffort: { type: "string", enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", ""], description: "可选思考强度；空字符串表示使用模型默认" },
  sandboxMode: { type: "string", enum: ["workspace", "unrestricted"], description: "默认 workspace；只有用户明确允许关闭 Codex 内置沙箱时才能用 unrestricted" },
};

const tools = [
  {
    name: "create_scheduled_task",
    title: "创建飞牛定时任务",
    description: "在 Codex 飞牛工作台中创建无人值守定时任务。用户明确要求创建、安排、每天、每周或每隔一段时间执行任务时使用。创建成功后必须向用户复述任务名称、计划、项目和任务 ID。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "简短任务名称" },
        prompt: { type: "string", description: "定时触发后交给 Codex 执行的完整指令" },
        projectPath: { type: "string", description: "当前项目的绝对路径；工作台只有一个项目时可省略" },
        schedule: scheduleInputSchema,
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
        ...taskOptionProperties,
      },
      required: ["name", "prompt", "schedule"],
    },
  },
  {
    name: "list_scheduled_tasks",
    title: "查看飞牛定时任务",
    description: "列出 Codex 飞牛工作台中的定时任务。用户询问已有计划、下次运行时间或确认是否创建成功时使用。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath: { type: "string", description: "可选，仅列出指定项目绝对路径下的任务" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "update_scheduled_task",
    title: "编辑飞牛定时任务",
    description: "编辑已有定时任务，也可暂停或恢复。用户要求修改提示词、频率、项目、供应商、模型、思考强度、沙箱或启用状态时使用。先用 list_scheduled_tasks 确认准确任务 ID；成功后必须复述改动后的任务。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1, description: "要编辑的定时任务 ID" },
        name: { type: "string", maxLength: 120 },
        prompt: { type: "string", maxLength: 20000 },
        projectPath: { type: "string", description: "可选，移动到这个已登记的项目绝对路径" },
        schedule: scheduleInputSchema,
        enabled: { type: "boolean", description: "false 暂停，true 恢复" },
        ...taskOptionProperties,
      },
      required: ["taskId"],
    },
  },
  {
    name: "delete_scheduled_task",
    title: "删除飞牛定时任务",
    description: "仅当用户明确要求删除某个定时任务时使用。先用 list_scheduled_tasks 核对准确任务 ID；删除任务不会删除已有结果会话。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string", minLength: 1, description: "要删除的定时任务 ID" } },
      required: ["taskId"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "create_new_conversation",
    title: "发起新的 Codex 会话",
    description: "仅当用户明确要求 Codex 新开、发起或移交到一个独立会话时使用。在对应项目中创建侧边栏可见的新会话，并立即把 prompt 作为首条任务发送。不要用它代替子代理；当前任务的内部并行工作应使用子代理。成功后必须向用户报告新会话标题、threadId 和启动状态。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: 120, description: "新会话在侧边栏显示的简短标题；省略时从 prompt 首行生成" },
        prompt: { type: "string", minLength: 1, maxLength: 20000, description: "发送给新会话的完整首条任务" },
        projectPath: { type: "string", description: "新会话所属项目的绝对路径" },
      },
      required: ["prompt", "projectPath"],
    },
  },
  {
    name: "create_global_skill",
    title: "创建全局 Skill",
    description: "在当前飞牛工作台账户的全局 Codex Home 中创建一个 Skill。仅在用户明确要求创建、保存或沉淀为全局 Skill 时使用；调用前先确认名称、用途和完整指令。不会覆盖同名 Skill。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$", description: "稳定的小写 Skill 名称" },
        description: { type: "string", minLength: 1, maxLength: 2000, description: "何时使用这个 Skill 的明确说明" },
        instructions: { type: "string", minLength: 1, maxLength: 500000, description: "写入 SKILL.md 的完整工作流指令" },
      },
      required: ["name", "description", "instructions"],
    },
  },
  {
    name: "create_global_plugin",
    title: "创建全局插件",
    description: "在当前飞牛工作台账户的个人插件市场中创建一个全局 skills-only 插件。仅在用户明确要求创建插件时使用；创建后插件会出现在插件市场中，仍需由用户安装后启用。不会覆盖同名插件。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$", description: "稳定的小写插件名" },
        displayName: { type: "string", maxLength: 120, description: "市场中显示的名称" },
        description: { type: "string", minLength: 1, maxLength: 2000, description: "插件用途" },
        skillName: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$", description: "插件内 Skill 名称；默认同插件名" },
        skillDescription: { type: "string", maxLength: 2000, description: "插件内 Skill 的触发说明；默认同插件说明" },
        instructions: { type: "string", minLength: 1, maxLength: 500000, description: "插件内 SKILL.md 的完整工作流指令" },
      },
      required: ["name", "description", "instructions"],
    },
  },
];

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export function handleScheduleMcpRequest(store, message, extensions, conversations) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "fnos-workbench", version: "0.9.13" },
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const args = message.params?.arguments || {};
    if (message.params?.name === "create_scheduled_task") return toolResult(store.create(args));
    if (message.params?.name === "list_scheduled_tasks") return toolResult({ data: store.list(args.projectPath) });
    if (message.params?.name === "update_scheduled_task") return toolResult(store.update(args.taskId, args));
    if (message.params?.name === "delete_scheduled_task") return toolResult(store.delete(args.taskId));
    if (message.params?.name === "create_new_conversation") {
      if (!conversations) throw new Error("新会话创建入口未配置");
      return conversations.create(args).then(toolResult);
    }
    if (message.params?.name === "create_global_skill") {
      if (!extensions) throw new Error("全局 Skill 创建入口未配置");
      return toolResult(extensions.createSkill(args));
    }
    if (message.params?.name === "create_global_plugin") {
      if (!extensions) throw new Error("全局插件创建入口未配置");
      return toolResult(extensions.createPlugin(args));
    }
    throw Object.assign(new Error(`未知工具：${message.params?.name || ""}`), { code: -32601 });
  }
  throw Object.assign(new Error(`不支持的方法：${message.method || ""}`), { code: -32601 });
}

export function runScheduleMcp(
  databasePath = process.env.FNOS_SCHEDULE_DB,
  codexHome = process.env.FNOS_CODEX_HOME,
  gatewayBaseUrl = process.env.FNOS_GATEWAY_BASE_URL,
  gatewayToken = process.env.FNOS_GATEWAY_TOKEN,
) {
  const store = new ScheduleToolStore(databasePath);
  const extensions = new GlobalExtensionService({ codexHome });
  const conversations = new ConversationClient(gatewayBaseUrl, gatewayToken);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
      if (message.id === undefined) return;
      const result = await handleScheduleMcpRequest(store, message, extensions, conversations);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    } catch (error) {
      if (message?.id === undefined) return;
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: error.code || -32603, message: error.message || "定时任务工具调用失败" },
      })}\n`);
    }
  });
  lines.on("close", () => store.close());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runScheduleMcp();
