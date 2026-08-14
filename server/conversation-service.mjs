import { randomUUID } from "node:crypto";
import { codexRuntimeConfig, modelProviderKey } from "./app-server-bridge.mjs";
import { composeDeveloperInstructions } from "./instructions.mjs";

function normalizeProjectPath(value) {
  return String(value || "").trim().replace(/[/\\]+$/, "");
}

export class ConversationService {
  constructor({ stores, bridge, onCreated }) {
    this.stores = stores;
    this.bridge = bridge;
    this.onCreated = onCreated || (() => {});
  }

  async create(input) {
    const requestedPath = normalizeProjectPath(input.projectPath);
    const projects = this.stores.listProjects();
    const project = requestedPath
      ? projects.find((item) => normalizeProjectPath(item.path) === requestedPath)
      : projects.length === 1 ? projects[0] : null;
    if (!project) {
      const message = requestedPath
        ? `未找到项目目录：${requestedPath}`
        : `存在多个项目，请传入当前项目绝对路径 projectPath。可选：${projects.map((item) => item.path).join("、")}`;
      throw Object.assign(new Error(message), { status: 404 });
    }

    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw Object.assign(new Error("新会话任务内容不能为空"), { status: 400 });
    if (prompt.length > 20_000) throw Object.assign(new Error("新会话任务内容不能超过 20000 个字符"), { status: 400 });
    const fallbackTitle = prompt.split(/\r?\n/).find((line) => line.trim())?.trim() || "Codex 发起的新会话";
    const title = String(input.title || fallbackTitle).trim().slice(0, 120) || "Codex 发起的新会话";
    const providerId = project.defaultProviderId || null;
    const provider = providerId ? this.stores.listProviders().find((item) => item.id === providerId && item.enabled) : null;
    if (providerId && !provider) throw Object.assign(new Error("项目默认供应商不存在或未启用"), { status: 409 });
    const settings = this.stores.getSettings();
    const approvalPolicy = settings.approvalPolicy;
    const networkAccess = settings.networkAccess;

    const started = await this.bridge.request("thread/start", {
      cwd: project.path,
      modelProvider: modelProviderKey(providerId),
      model: provider?.model || undefined,
      config: codexRuntimeConfig(),
      approvalPolicy,
      sandbox: "workspace-write",
      developerInstructions: composeDeveloperInstructions(settings, project.instructions),
      personality: "friendly",
      serviceName: "codex_fnos_handoff",
    });
    const threadId = started.thread.id;
    this.stores.saveThreadDisplayName(threadId, title);
    this.stores.saveThreadApprovalPolicy(threadId, started.approvalPolicy ?? approvalPolicy);
    this.stores.saveThreadNetworkAccess(threadId, networkAccess);
    this.stores.saveThreadProjectId(threadId, project.id);

    const thread = {
      ...started.thread,
      name: title,
      projectId: project.id,
      approvalPolicy: started.approvalPolicy ?? approvalPolicy,
      networkAccess,
    };
    this.onCreated({ projectId: project.id, thread });

    try {
      const turn = await this.bridge.request("turn/start", {
        threadId,
        clientUserMessageId: `handoff-${randomUUID()}`,
        input: [{ type: "text", text: prompt }],
        approvalPolicy: started.approvalPolicy ?? approvalPolicy,
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [project.path], networkAccess },
        model: provider?.model || undefined,
      });
      return {
        status: "started",
        threadId,
        turnId: turn.turn.id,
        title,
        projectId: project.id,
        projectPath: project.path,
      };
    } catch (error) {
      return {
        status: "createdWithoutTurn",
        threadId,
        turnId: null,
        title,
        projectId: project.id,
        projectPath: project.path,
        error: error.message || "新会话首条任务启动失败",
      };
    }
  }
}
