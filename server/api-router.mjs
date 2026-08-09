import { randomUUID } from "node:crypto";
import { modelProviderKey } from "./app-server-bridge.mjs";
import { readBuffer, readJson, route, sendError, sendJson } from "./lib/http.mjs";
import { endpoint, listProviderModels, testProvider, testProxy } from "./provider-client.mjs";

function normalizeThreadCwd(value) {
  let normalized = String(value ?? "").trim();
  if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  normalized = normalized.replace(/[\\/]+$/, "");
  if (process.platform === "win32") normalized = normalized.replaceAll("/", "\\").toLowerCase();
  return normalized;
}

function filterThreadsByCwd(result, cwd) {
  if (!cwd || !Array.isArray(result?.data)) return result;
  const expected = normalizeThreadCwd(cwd);
  return {
    ...result,
    data: result.data.filter((thread) => normalizeThreadCwd(thread.cwd) === expected),
  };
}

const reasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const imageDataUrl = /^data:image\/(png|jpeg|webp|gif);base64,([a-z\d+/=]+)$/i;
const threadSourceKinds = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

function buildTurnInput(input, availableSkills = []) {
  const result = [];
  const text = String(input.text || "");
  const requestedSkills = Array.isArray(input.skills) ? input.skills : [];
  if (requestedSkills.length > 6) throw Object.assign(new Error("每次最多选择 6 个 Skills"), { status: 400 });
  const selectedSkills = requestedSkills.map((requested) => {
    const path = String(requested?.path || "");
    const skill = availableSkills.find((item) => String(item.path) === path && item.enabled !== false);
    if (!skill) throw Object.assign(new Error(`Skill ${String(requested?.name || path || "未知")} 不可用`), { status: 400 });
    return skill;
  });
  const markers = selectedSkills.map((skill) => `$${skill.name}`).join(" ");
  const prompt = [markers, text.trim()].filter(Boolean).join("\n\n");
  if (prompt) result.push({ type: "text", text: prompt });
  for (const skill of selectedSkills) result.push({ type: "skill", name: skill.name, path: skill.path });
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  if (attachments.length > 6) throw Object.assign(new Error("每次最多添加 6 个附件"), { status: 400 });
  for (const attachment of attachments) {
    const name = String(attachment?.name || "未命名附件").slice(0, 180);
    if (attachment?.kind === "image") {
      const match = String(attachment.dataUrl || "").match(imageDataUrl);
      if (!match) throw Object.assign(new Error(`${name} 不是受支持的 PNG、JPEG、WebP 或 GIF 图片`), { status: 415 });
      if (Buffer.byteLength(match[2], "base64") > 6 * 1024 * 1024) throw Object.assign(new Error(`${name} 超过 6 MB`), { status: 413 });
      result.push({ type: "image", url: attachment.dataUrl, detail: "auto" });
      continue;
    }
    if (attachment?.kind === "text") {
      const content = String(attachment.content || "");
      if (Buffer.byteLength(content) > 512 * 1024) throw Object.assign(new Error(`${name} 超过 512 KB`), { status: 413 });
      result.push({ type: "text", text: `\n\n<fnos_attachment name=${JSON.stringify(name)}>\n${content}\n</fnos_attachment>` });
      continue;
    }
    throw Object.assign(new Error(`${name} 的附件类型不受支持`), { status: 415 });
  }
  if (result.length === 0) throw Object.assign(new Error("消息或附件不能为空"), { status: 400 });
  return result;
}

function readReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (!effort) return undefined;
  if (!reasoningEfforts.has(effort)) throw Object.assign(new Error("思考强度无效"), { status: 400 });
  return effort;
}

function readApprovalPolicy(value) {
  const policy = String(value || "").trim();
  if (!policy) return undefined;
  if (!["on-request", "never"].includes(policy)) throw Object.assign(new Error("审批方式无效"), { status: 400 });
  return policy;
}

function publicCodexStatus(value) {
  const { binaryPath: _binaryPath, packageVersion: _packageVersion, ...result } = value;
  return result;
}

export function createApiHandler({ stores, bridge, queueBridgeRestart, appearance, updater, workspace, skills }) {
  const findProject = (id) => stores.listProjects().find((item) => item.id === id);
  const findProvider = (id) => stores.listProviders().find((item) => item.id === id);
  const decorateThread = (thread, extra = {}) => {
    const preferences = stores.getThreadPreferences(thread.id);
    return {
      ...thread,
      ...extra,
      approvalPolicy: preferences?.approvalPolicy ?? undefined,
      name: preferences?.name ?? undefined,
      pinned: preferences?.pinned ?? false,
    };
  };
  const sortThreads = (threads) => [...threads].sort((left, right) =>
    Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
      || Number(right.updatedAt ?? right.createdAt ?? 0) - Number(left.updatedAt ?? left.createdAt ?? 0));

  return async function handleApi(req, res, url) {
    const { pathname, searchParams } = url;
    let params;
    if (req.method === "GET" && pathname === "/api/bootstrap") {
      let account = null;
      if (bridge.snapshot().status === "ready") {
        try {
          account = await bridge.request("account/read", { refreshToken: false }, { timeoutMs: 15_000 });
        } catch {
          account = null;
        }
      }
      sendJson(res, 200, {
        version: "0.5.0",
        providers: stores.listProviders(),
        proxies: stores.listProxies(),
        projects: stores.listProjects(),
        settings: stores.getSettings(),
        bridge: bridge.snapshot(),
        account,
        codex: publicCodexStatus(updater.status()),
        appearance: appearance.status(),
      });
      return;
    }

    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/skills$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, await skills.list(project, searchParams.get("reload") === "1"));
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/projects\/(?<id>[^/]+)\/skills$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, await skills.setEnabled(project, await readJson(req)));
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/skills\/detail$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, await skills.read(project, searchParams.get("path") || ""));
      return;
    }

    if (req.method === "GET" && pathname === "/api/providers") {
      sendJson(res, 200, { data: stores.listProviders() });
      return;
    }
    if (req.method === "GET" && pathname === "/api/workspace-roots") {
      sendJson(res, 200, { data: stores.listWorkspaceCandidates() });
      return;
    }
    if (req.method === "POST" && pathname === "/api/workspace-roots") {
      const input = await readJson(req);
      sendJson(res, 200, stores.addWorkspaceRoot(input.path));
      return;
    }
    if (req.method === "GET" && pathname === "/api/models") {
      const providerId = searchParams.get("providerId");
      if (!providerId) {
        sendJson(res, 200, await bridge.request("model/list", { limit: 100, includeHidden: false }));
        return;
      }
      const provider = stores.getProviderSecret(providerId);
      if (!provider) return sendError(res, 404, "供应商不存在");
      try {
        const models = await listProviderModels(provider, stores.getEffectiveProxy(provider));
        sendJson(res, 200, {
          data: models.map((model) => ({ id: model, model, displayName: model, description: "", isDefault: model === provider.model })),
          nextCursor: null,
          source: endpoint(provider.base_url, "models"),
        });
      } catch (error) {
        sendJson(res, 200, {
          data: [{ id: provider.model, model: provider.model, displayName: provider.model, description: "供应商默认模型", isDefault: true }],
          nextCursor: null,
          warning: error.message,
        });
      }
      return;
    }
    if (req.method === "POST" && pathname === "/api/providers/models") {
      const input = await readJson(req);
      const existing = input.providerId ? stores.getProviderSecret(input.providerId) : null;
      let headers = input.headers ?? existing?.headers ?? {};
      if (typeof headers === "string") headers = JSON.parse(headers || "{}");
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("附加请求头必须是 JSON 对象");
      const baseUrl = String(input.baseUrl ?? existing?.base_url ?? "").trim().replace(/\/$/, "");
      if (!baseUrl) throw Object.assign(new Error("请先填写供应商 Base URL"), { status: 400 });
      const proxyMode = input.proxyMode
        ?? existing?.proxy_mode
        ?? (input.proxyProfileId ? "profile" : "inherit");
      const provider = {
        base_url: baseUrl,
        protocol: input.protocol ?? existing?.protocol ?? "responses",
        model: String(input.model ?? existing?.model ?? "").trim(),
        apiKey: input.apiKey ? String(input.apiKey).trim() : existing?.apiKey ?? "",
        headers,
        proxy_profile_id: proxyMode === "profile" ? input.proxyProfileId || existing?.proxy_profile_id || null : null,
        proxy_mode: proxyMode,
      };
      const models = await listProviderModels(provider, stores.getEffectiveProxy(provider));
      sendJson(res, 200, {
        data: models.map((model) => ({ id: model, model, displayName: model })),
        source: endpoint(provider.base_url, "models"),
      });
      return;
    }
    if (req.method === "POST" && pathname === "/api/providers") {
      const provider = stores.saveProvider(await readJson(req));
      queueBridgeRestart();
      sendJson(res, 201, { provider });
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/providers\/(?<id>[^/]+)$/ });
    if (params) {
      const provider = stores.saveProvider(await readJson(req), params.id);
      queueBridgeRestart();
      sendJson(res, 200, { provider });
      return;
    }
    params = route(req.method, pathname, { method: "DELETE", path: /^\/api\/providers\/(?<id>[^/]+)$/ });
    if (params) {
      const deleted = stores.deleteProvider(params.id);
      queueBridgeRestart();
      sendJson(res, deleted ? 200 : 404, { deleted });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/providers\/(?<id>[^/]+)\/test$/ });
    if (params) {
      const provider = stores.getProviderSecret(params.id);
      if (!provider) return sendError(res, 404, "供应商不存在");
      sendJson(res, 200, await testProvider(provider, stores.getEffectiveProxy(provider)));
      return;
    }

    if (req.method === "GET" && pathname === "/api/proxies") {
      sendJson(res, 200, { data: stores.listProxies() });
      return;
    }
    if (req.method === "POST" && pathname === "/api/proxies") {
      const proxy = stores.saveProxy(await readJson(req));
      sendJson(res, 201, { proxy });
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/proxies\/(?<id>[^/]+)$/ });
    if (params) {
      const proxy = stores.saveProxy(await readJson(req), params.id);
      queueBridgeRestart();
      sendJson(res, 200, { proxy });
      return;
    }
    params = route(req.method, pathname, { method: "DELETE", path: /^\/api\/proxies\/(?<id>[^/]+)$/ });
    if (params) {
      const deleted = stores.deleteProxy(params.id);
      queueBridgeRestart();
      sendJson(res, deleted ? 200 : 404, { deleted });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/proxies\/(?<id>[^/]+)\/test$/ });
    if (params) {
      const proxy = stores.getProxySecret(params.id);
      if (!proxy) return sendError(res, 404, "代理不存在");
      const input = await readJson(req);
      sendJson(res, 200, await testProxy(proxy, input.target));
      return;
    }

    if (req.method === "PATCH" && pathname === "/api/settings") {
      const input = await readJson(req);
      const settings = stores.saveSettings(input);
      if ("defaultProxyId" in input || "approvalPolicy" in input) queueBridgeRestart();
      sendJson(res, 200, { settings });
      return;
    }

    if (req.method === "GET" && pathname === "/api/appearance/background") {
      if (!appearance.send(res)) sendError(res, 404, "还没有设置背景图片");
      return;
    }
    if (req.method === "POST" && pathname === "/api/appearance/background") {
      sendJson(res, 200, appearance.save(await readBuffer(req, 8 * 1024 * 1024)));
      return;
    }
    if (req.method === "DELETE" && pathname === "/api/appearance/background") {
      sendJson(res, 200, appearance.remove());
      return;
    }

    if (req.method === "GET" && pathname === "/api/codex/update") {
      sendJson(res, 200, publicCodexStatus(await updater.check()));
      return;
    }
    if (req.method === "POST" && pathname === "/api/codex/update") {
      const previous = updater.status();
      const result = await updater.installLatest();
      if (result.installed) {
        bridge.setCodexBin(result.binaryPath);
        try {
          await bridge.restart();
        } catch (error) {
          updater.activate(previous);
          bridge.setCodexBin(previous.binaryPath);
          await bridge.restart().catch(() => {});
          throw new Error(`Codex 新版本启动失败，已回退到 ${previous.currentVersion}：${error.message}`);
        }
      }
      sendJson(res, 200, { ...publicCodexStatus(result), bridge: bridge.snapshot() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      sendJson(res, 200, { data: stores.listProjects() });
      return;
    }
    if (req.method === "GET" && pathname === "/api/filesystem/browse") {
      sendJson(res, 200, stores.browseDirectories(searchParams.get("path") || undefined));
      return;
    }
    if (req.method === "POST" && pathname === "/api/projects") {
      sendJson(res, 201, { project: stores.saveProject(await readJson(req)) });
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/projects\/(?<id>[^/]+)$/ });
    if (params) {
      sendJson(res, 200, { project: stores.saveProject(await readJson(req), params.id) });
      return;
    }
    params = route(req.method, pathname, { method: "DELETE", path: /^\/api\/projects\/(?<id>[^/]+)$/ });
    if (params) {
      const deleted = stores.deleteProject(params.id);
      sendJson(res, deleted ? 200 : 404, { deleted });
      return;
    }

    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/files$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, workspace.list(project, searchParams.get("path") || ""));
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/file$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, workspace.read(project, searchParams.get("path") || ""));
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/changes$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, await workspace.changes(project));
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/diff$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, await workspace.diff(project, searchParams.get("path") || ""));
      return;
    }

    if (req.method === "GET" && pathname === "/api/threads/search") {
      const query = String(searchParams.get("query") || "").trim();
      if (!query) return sendJson(res, 200, { data: [] });
      const list = async (archived, searchTerm) => bridge.request("thread/list", {
        limit: 100,
        archived,
        searchTerm,
        modelProviders: [],
        sourceKinds: threadSourceKinds,
      });
      const [active, archived, allActive, allArchived] = await Promise.all([
        list(false, query),
        list(true, query),
        list(false, undefined),
        list(true, undefined),
      ]);
      const projects = stores.listProjects();
      const decorateSearchResult = (thread, isArchived) => {
        const project = projects.find((item) => normalizeThreadCwd(item.path) === normalizeThreadCwd(thread.cwd));
        return decorateThread(thread, {
          archived: isArchived,
          projectId: project?.id,
          projectName: project?.name,
        });
      };
      const decorated = [
        ...(active.data ?? []).map((thread) => decorateSearchResult(thread, false)),
        ...(archived.data ?? []).map((thread) => decorateSearchResult(thread, true)),
        ...(allActive.data ?? []).map((thread) => decorateSearchResult(thread, false)),
        ...(allArchived.data ?? []).map((thread) => decorateSearchResult(thread, true)),
      ];
      const normalizedQuery = query.toLocaleLowerCase();
      const unique = new Map();
      for (const thread of decorated) {
        if (stores.getThreadPreferences(thread.id)?.deleted) continue;
        const matchesLocal = `${thread.name ?? ""}\n${thread.preview ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
        const matchedByServer = (active.data ?? []).some((item) => item.id === thread.id)
          || (archived.data ?? []).some((item) => item.id === thread.id);
        if ((matchesLocal || matchedByServer) && !unique.has(thread.id)) unique.set(thread.id, thread);
      }
      sendJson(res, 200, { data: sortThreads([...unique.values()]) });
      return;
    }
    if (req.method === "GET" && pathname === "/api/threads") {
      const cwd = searchParams.get("cwd") || undefined;
      const archived = searchParams.get("archived") === "1";
      const result = await bridge.request("thread/list", {
        limit: 100,
        archived,
        // An empty provider list means "all providers". Without it, app-server
        // silently limits results to its process-level default provider and hides
        // threads created with a third-party provider override.
        modelProviders: [],
        sourceKinds: threadSourceKinds,
      });
      // Filter after listing. On Windows, Codex persists canonical cwd values
      // with a \\?\ prefix, which does not match thread/list's SQL cwd filter.
      const filtered = filterThreadsByCwd(result, cwd);
      sendJson(res, 200, {
        ...filtered,
        data: sortThreads(filtered.data
          ?.filter((thread) => !stores.getThreadPreferences(thread.id)?.deleted)
          .map((thread) => decorateThread(thread, { archived })) ?? []),
      });
      return;
    }
    if (req.method === "POST" && pathname === "/api/threads") {
      const input = await readJson(req);
      const project = findProject(input.projectId);
      if (!project) return sendError(res, 404, "项目不存在");
      const providerId = input.providerId || project.defaultProviderId || null;
      const provider = providerId ? findProvider(providerId) : null;
      const approvalPolicy = readApprovalPolicy(input.approvalPolicy) ?? stores.getSettings().approvalPolicy;
      const result = await bridge.request("thread/start", {
        cwd: project.path,
        modelProvider: modelProviderKey(providerId),
        model: input.model || provider?.model || undefined,
        config: input.effort ? { model_reasoning_effort: readReasoningEffort(input.effort) } : undefined,
        approvalPolicy,
        sandbox: "workspace-write",
        personality: "friendly",
        serviceName: "codex_fnos_web",
      });
      stores.saveThreadApprovalPolicy(result.thread.id, result.approvalPolicy ?? approvalPolicy);
      sendJson(res, 201, result);
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/threads\/(?<id>[^/]+)$/ });
    if (params) {
      sendJson(res, 200, await bridge.request("thread/read", { threadId: params.id, includeTurns: true }));
      return;
    }
    params = route(req.method, pathname, { method: "DELETE", path: /^\/api\/threads\/(?<id>[^/]+)$/ });
    if (params) {
      await bridge.request("thread/archive", { threadId: params.id });
      stores.saveThreadDeleted(params.id);
      sendJson(res, 200, { deleted: true });
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/threads\/(?<id>[^/]+)$/ });
    if (params) {
      const input = await readJson(req);
      const result = {};
      if (Object.hasOwn(input, "name")) result.name = stores.saveThreadDisplayName(params.id, input.name);
      if (Object.hasOwn(input, "pinned")) result.pinned = stores.saveThreadPinned(params.id, Boolean(input.pinned));
      sendJson(res, 200, { thread: { id: params.id, ...result } });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/resume$/ });
    if (params) {
      const result = await bridge.request("thread/resume", { threadId: params.id });
      const approvalPolicy = stores.getThreadApprovalPolicy(params.id);
      if (approvalPolicy && approvalPolicy !== result.approvalPolicy) {
        await bridge.request("thread/settings/update", { threadId: params.id, approvalPolicy });
      }
      sendJson(res, 200, {
        ...result,
        thread: decorateThread(result.thread),
        approvalPolicy: approvalPolicy ?? result.approvalPolicy,
      });
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/threads\/(?<id>[^/]+)\/settings$/ });
    if (params) {
      const input = await readJson(req);
      const approvalPolicy = readApprovalPolicy(input.approvalPolicy);
      sendJson(res, 200, await bridge.request("thread/settings/update", {
        threadId: params.id,
        model: input.model || undefined,
        effort: readReasoningEffort(input.effort),
        approvalPolicy,
      }));
      if (approvalPolicy) stores.saveThreadApprovalPolicy(params.id, approvalPolicy);
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/fork$/ });
    if (params) {
      const input = await readJson(req);
      const result = await bridge.request("thread/fork", {
        threadId: params.id,
        lastTurnId: input.lastTurnId || undefined,
        beforeTurnId: input.beforeTurnId || undefined,
      });
      const approvalPolicy = stores.getThreadApprovalPolicy(params.id);
      if (approvalPolicy && result.thread?.id) stores.saveThreadApprovalPolicy(result.thread.id, approvalPolicy);
      sendJson(res, 201, result);
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/archive$/ });
    if (params) {
      sendJson(res, 200, await bridge.request("thread/archive", { threadId: params.id }));
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/unarchive$/ });
    if (params) {
      sendJson(res, 200, await bridge.request("thread/unarchive", { threadId: params.id }));
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/turns$/ });
    if (params) {
      const input = await readJson(req, 12 * 1024 * 1024);
      const approvalPolicy = readApprovalPolicy(input.approvalPolicy);
      let availableSkills = [];
      if (Array.isArray(input.skills) && input.skills.length > 0) {
        const project = findProject(input.projectId);
        if (!project) return sendError(res, 404, "当前会话所属项目不存在");
        availableSkills = (await skills.list(project, false)).skills;
      }
      sendJson(res, 202, await bridge.request("turn/start", {
        threadId: params.id,
        clientUserMessageId: input.clientId || randomUUID(),
        input: buildTurnInput(input, availableSkills),
        approvalPolicy,
        model: input.model || undefined,
        effort: readReasoningEffort(input.effort),
      }));
      if (approvalPolicy) stores.saveThreadApprovalPolicy(params.id, approvalPolicy);
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/interrupt$/ });
    if (params) {
      const input = await readJson(req);
      sendJson(res, 200, await bridge.request("turn/interrupt", { threadId: params.id, turnId: input.turnId }));
      return;
    }

    if (req.method === "POST" && pathname === "/api/rpc/respond") {
      const input = await readJson(req);
      bridge.respond(input.id, input.result, input.error);
      sendJson(res, 200, { accepted: true });
      return;
    }
    if (req.method === "GET" && pathname === "/api/account") {
      sendJson(res, 200, await bridge.request("account/read", { refreshToken: false }));
      return;
    }
    if (req.method === "POST" && pathname === "/api/account/login") {
      const input = await readJson(req);
      const login = input.type === "apiKey"
        ? { type: "apiKey", apiKey: input.apiKey }
        : { type: "chatgptDeviceCode" };
      try {
        sendJson(res, 200, await bridge.request("account/login/start", login));
      } catch (error) {
        if (input.type !== "apiKey" && /403|forbidden|device code request failed/i.test(error.message)) {
          const translated = new Error("ChatGPT 设备码登录被官方接口拒绝（HTTP 403）。第三方供应商无需在这里登录；如需使用官方 ChatGPT，请先设置可用的应用默认代理，或改用 OpenAI API Key。");
          translated.status = 502;
          translated.details = error.message;
          throw translated;
        }
        throw error;
      }
      return;
    }
    if (req.method === "POST" && pathname === "/api/account/logout") {
      sendJson(res, 200, await bridge.request("account/logout", {}));
      return;
    }
    if (req.method === "POST" && pathname === "/api/bridge/restart") {
      await bridge.restart();
      sendJson(res, 200, { bridge: bridge.snapshot() });
      return;
    }

    sendError(res, 404, "接口不存在");
  };
}

export { buildTurnInput, readApprovalPolicy, readReasoningEffort };
