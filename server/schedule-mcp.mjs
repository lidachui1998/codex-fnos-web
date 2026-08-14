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
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
  };
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

  list(projectPath = "") {
    const requested = normalizeProjectPath(projectPath);
    const rows = requested
      ? this.db.prepare(`
          SELECT task.*, project.name AS project_name, project.path AS project_path
          FROM scheduled_tasks task JOIN projects project ON project.id = task.project_id
          WHERE project.path = ? ORDER BY task.updated_at DESC
        `).all(requested)
      : this.db.prepare(`
          SELECT task.*, project.name AS project_name, project.path AS project_path
          FROM scheduled_tasks task JOIN projects project ON project.id = task.project_id
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
    const timestamp = now();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO scheduled_tasks (
        id, name, project_id, prompt, schedule_json, enabled, network_access,
        next_run_at, last_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)
    `).run(
      id,
      name,
      project.id,
      prompt,
      JSON.stringify(schedule),
      enabled ? 1 : 0,
      enabled ? computeNextRun(schedule) : null,
      timestamp,
      timestamp,
    );
    return this.list(project.path).find((task) => task.id === id);
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
        schedule: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["interval", "daily", "weekly"] },
            minutes: { type: "integer", minimum: 5, maximum: 10080, description: "interval 使用" },
            time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "daily/weekly 使用，NAS 本地时间 HH:mm" },
            days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "weekly 使用，0=周日，1=周一，...，6=周六" },
          },
          required: ["type"],
        },
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
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
      serverInfo: { name: "fnos-workbench", version: "0.9.5" },
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const args = message.params?.arguments || {};
    if (message.params?.name === "create_scheduled_task") return toolResult(store.create(args));
    if (message.params?.name === "list_scheduled_tasks") return toolResult({ data: store.list(args.projectPath) });
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
