import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { codexRuntimeConfig, modelProviderKey } from "./app-server-bridge.mjs";
import { composeDeveloperInstructions } from "./instructions.mjs";
import { readBuffer, readJson, route, sendError, sendJson } from "./lib/http.mjs";
import { buildPluginInstallParams, quarantineLegacyPluginCache, resolvePluginInstallId, resolvePluginUninstallId } from "./plugin-install.mjs";
import { endpoint, listProviderModels, testProvider, testProxy } from "./provider-client.mjs";
import { decodeProviderRoute, encodeProviderRoute } from "./provider-routing.mjs";

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

function findActiveTurn(thread) {
  if (!Array.isArray(thread?.turns)) return null;
  return [...thread.turns].reverse().find((turn) => turn?.status === "inProgress") ?? null;
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

function prepareOutboxMessage(input, availableSkills = []) {
  const turnInput = buildTurnInput(input, availableSkills);
  const requestedSkills = Array.isArray(input.skills) ? input.skills : [];
  const selectedSkills = requestedSkills.map((requested) => {
    const skill = availableSkills.find((item) => String(item.path) === String(requested?.path || "") && item.enabled !== false);
    return { name: skill.name, path: skill.path };
  });
  const attachments = (Array.isArray(input.attachments) ? input.attachments : []).map((attachment) => {
    const name = String(attachment?.name || "未命名附件").slice(0, 180);
    if (attachment?.kind === "image") {
      const match = String(attachment.dataUrl || "").match(imageDataUrl);
      return {
        id: randomUUID(),
        kind: "image",
        name,
        size: Buffer.byteLength(match[2], "base64"),
        dataUrl: attachment.dataUrl,
      };
    }
    const content = String(attachment.content || "");
    return { id: randomUUID(), kind: "text", name, size: Buffer.byteLength(content), content };
  });
  return {
    turnInput,
    displayPayload: {
      text: String(input.text || ""),
      attachments,
      skills: selectedSkills,
    },
  };
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

function readRetryProvider(input, providers) {
  const providerId = input.providerId ? String(input.providerId) : null;
  const provider = providerId ? providers.find((item) => item.id === providerId) : null;
  if (providerId && (!provider || !provider.enabled)) throw Object.assign(new Error("所选供应商不存在或未启用"), { status: 400 });
  return {
    providerId,
    provider,
    model: String(input.model || provider?.model || "").trim(),
    effort: readReasoningEffort(input.effort),
  };
}

function publicCodexStatus(value) {
  const { binaryPath: _binaryPath, packageVersion: _packageVersion, ...result } = value;
  return result;
}

export function createApiHandler({ stores, bridge, accounts, queueBridgeRestart, appearance, updater, workspace, skills, extensions, schedules, notifications, subagentJoins = null, outbox = null }) {
  const findProject = (id) => stores.listProjects().find((item) => item.id === id);
  const findProvider = (id) => stores.listProviders().find((item) => item.id === id);
  const decorateThread = (thread, extra = {}) => {
    const preferences = stores.getThreadPreferences(thread.id);
    const route = decodeProviderRoute(thread.model);
    const runtimeModelProvider = thread.runtimeModelProvider ?? thread.modelProvider;
    return {
      ...thread,
      model: route?.model ?? thread.model,
      modelProvider: route ? modelProviderKey(route.providerId) : thread.modelProvider,
      runtimeModelProvider,
      ...extra,
      approvalPolicy: preferences?.approvalPolicy ?? undefined,
      networkAccess: preferences?.networkAccess ?? stores.getSettings().networkAccess,
      name: preferences?.name ?? undefined,
      pinned: preferences?.pinned ?? false,
      archived: extra.archived ?? preferences?.archivedLocal ?? thread.archived ?? false,
    };
  };
  const sortThreads = (threads) => [...threads].sort((left, right) =>
    Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
      || Number(right.updatedAt ?? right.createdAt ?? 0) - Number(left.updatedAt ?? left.createdAt ?? 0));
  const pluginRequest = async (method, params) => {
    try {
      return await bridge.request(method, params);
    } catch (error) {
      if (/method not found|unknown method|plugin.*not enabled/i.test(error.message)) {
        const translated = new Error("当前 Codex 核心不支持插件接口，请先在“Codex 更新”中升级官方核心");
        translated.status = 503;
        translated.details = error.message;
        throw translated;
      }
      throw error;
    }
  };

  return async function handleApi(req, res, url) {
    const { pathname, searchParams } = url;
    let params;
    if (req.method === "GET" && pathname === "/api/bootstrap") {
      let account = null;
      if (bridge.snapshot().status === "ready") {
        try {
          account = await accounts.readActive();
        } catch {
          account = null;
        }
      }
      sendJson(res, 200, {
        version: "0.9.13",
        providers: stores.listProviders(),
        proxies: stores.listProxies(),
        projects: stores.listProjects(),
        settings: stores.getSettings(),
        bridge: bridge.snapshot(),
        account,
        accounts: accounts.list(),
        activeAccountId: accounts.active().id,
        codex: publicCodexStatus(updater.status()),
        appearance: appearance.status(),
        notificationSummary: notifications.summary(),
      });
      return;
    }
    if (req.method === "GET" && pathname === "/api/outbox") {
      sendJson(res, 200, { data: outbox?.list(searchParams.get("threadId")) ?? [] });
      return;
    }
    params = route(req.method, pathname, { method: "DELETE", path: /^\/api\/outbox\/(?<id>[^/]+)$/ });
    if (params) {
      if (!outbox?.remove(params.id)) return sendError(res, 404, "等待消息不存在");
      sendJson(res, 200, { deleted: true });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/outbox\/(?<id>[^/]+)\/retry$/ });
    if (params) {
      const message = outbox?.retry(params.id);
      if (!message) return sendError(res, 404, "等待消息不存在");
      sendJson(res, 200, { message });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/outbox\/(?<id>[^/]+)\/steer$/ });
    if (params) {
      const input = await readJson(req);
      const expectedTurnId = typeof input.expectedTurnId === "string" ? input.expectedTurnId.trim() : "";
      if (!expectedTurnId) return sendError(res, 400, "缺少当前任务 ID，无法立即追加消息");
      sendJson(res, 202, await outbox.steer(params.id, expectedTurnId));
      return;
    }

    if (req.method === "GET" && pathname === "/api/notifications") {
      sendJson(res, 200, notifications.list({
        filter: searchParams.get("filter") || "all",
        limit: searchParams.get("limit") || 100,
      }));
      return;
    }
    if (req.method === "POST" && pathname === "/api/notifications/read-all") {
      sendJson(res, 200, { changed: notifications.markAllRead(), summary: notifications.summary() });
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/notifications\/(?<id>[^/]+)$/ });
    if (params) {
      const input = await readJson(req);
      const changed = notifications.markRead(params.id, input.read !== false);
      sendJson(res, changed ? 200 : 404, { changed, summary: notifications.summary() });
      return;
    }
    if (req.method === "GET" && pathname === "/api/notification-channels") {
      sendJson(res, 200, { data: notifications.listChannels() });
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/notification-channels\/(?<channel>[^/]+)$/ });
    if (params) {
      sendJson(res, 200, { channel: notifications.saveChannel(params.channel, await readJson(req)) });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/notification-channels\/(?<channel>[^/]+)\/test$/ });
    if (params) {
      sendJson(res, 200, await notifications.testChannel(params.channel));
      return;
    }

    if (req.method === "GET" && pathname === "/api/schedules") {
      sendJson(res, 200, { data: schedules.list(), safetyMode: "explicitUnrestrictedOptIn" });
      return;
    }
    if (req.method === "POST" && pathname === "/api/schedules/import/preview") {
      sendJson(res, 200, { preview: schedules.previewDesktopImport(await readJson(req, 1024 * 1024)) });
      return;
    }
    if (req.method === "POST" && pathname === "/api/schedules/import") {
      sendJson(res, 201, schedules.importDesktop(await readJson(req, 1024 * 1024)));
      return;
    }
    if (req.method === "POST" && pathname === "/api/schedules") {
      sendJson(res, 201, { task: schedules.save(await readJson(req)) });
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/schedules\/(?<id>[^/]+)$/ });
    if (params) {
      sendJson(res, 200, { task: schedules.save(await readJson(req), params.id) });
      return;
    }
    params = route(req.method, pathname, { method: "DELETE", path: /^\/api\/schedules\/(?<id>[^/]+)$/ });
    if (params) {
      const deleted = schedules.delete(params.id);
      sendJson(res, deleted ? 200 : 404, { deleted });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/schedules\/(?<id>[^/]+)\/run$/ });
    if (params) {
      sendJson(res, 202, await schedules.runNow(params.id));
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
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/projects\/(?<id>[^/]+)\/skills\/install$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 201, await skills.install(project, await readJson(req, 8 * 1024)));
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/projects\/(?<id>[^/]+)\/skills\/import$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      const filename = String(searchParams.get("name") || "skill.zip").slice(0, 180);
      const installed = extensions.importSkill(await readBuffer(req, 30 * 1024 * 1024), filename);
      sendJson(res, 201, { installed, ...(await skills.list(project, true)) });
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/skills\/detail$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, await skills.read(project, searchParams.get("path") || ""));
      return;
    }

    if (req.method === "GET" && pathname === "/api/plugins") {
      const result = await pluginRequest("plugin/list", {
        cwds: stores.listProjects().map((project) => project.path),
        forceRefetch: searchParams.get("reload") === "1",
      });
      const data = (result.marketplaces ?? []).flatMap((marketplace) =>
        (marketplace.plugins ?? []).map((plugin) => ({
          ...plugin,
          marketplaceName: marketplace.name,
          marketplacePath: marketplace.path ?? null,
        })));
      sendJson(res, 200, {
        data,
        errors: result.marketplaceLoadErrors ?? [],
        featuredPluginIds: result.featuredPluginIds ?? [],
      });
      return;
    }
    if (req.method === "POST" && pathname === "/api/plugins/install") {
      const input = await readJson(req);
      const pluginName = String(input.pluginName || "").trim();
      if (!pluginName) return sendError(res, 400, "插件名称不能为空");
      let catalog;
      try {
        catalog = await pluginRequest("plugin/list", {
          cwds: stores.listProjects().map((project) => project.path),
          forceRefetch: false,
        });
      } catch (error) {
        const translated = new Error(`安装前无法解析插件远程 ID：${error.message}`);
        translated.status = error.status || 502;
        throw translated;
      }
      const resolved = resolvePluginInstallId(catalog, input);
      const legacyCache = quarantineLegacyPluginCache(bridge.codexHome, input, resolved.pluginId);
      const result = await pluginRequest("plugin/install", buildPluginInstallParams(resolved));
      sendJson(res, 201, {
        ...result,
        resolvedPluginId: resolved.pluginId,
        legacyCacheQuarantined: Boolean(legacyCache),
      });
      return;
    }
    if (req.method === "POST" && pathname === "/api/plugins/import") {
      const filename = String(searchParams.get("name") || "plugin.zip").slice(0, 180);
      const imported = extensions.importPlugin(await readBuffer(req, 30 * 1024 * 1024), filename);
      let installation = null;
      let installError = null;
      try {
        const catalog = await pluginRequest("plugin/list", {
          cwds: stores.listProjects().map((project) => project.path),
          forceRefetch: true,
        });
        const resolved = resolvePluginInstallId(catalog, {
          pluginName: imported.name,
          marketplaceName: imported.marketplaceName,
        });
        installation = await pluginRequest("plugin/install", buildPluginInstallParams(resolved));
      } catch (error) {
        installError = error.message || "插件已导入全局市场，但自动安装失败";
      }
      sendJson(res, 201, { imported, installation, installError });
      return;
    }
    params = route(req.method, pathname, { method: "DELETE", path: /^\/api\/plugins\/(?<id>[^/]+)$/ });
    if (params) {
      const requestedId = decodeURIComponent(params.id);
      const catalog = await pluginRequest("plugin/list", {
        cwds: stores.listProjects().map((project) => project.path),
        forceRefetch: false,
      });
      const pluginId = resolvePluginUninstallId(catalog, requestedId);
      await pluginRequest("plugin/uninstall", { pluginId });
      sendJson(res, 200, { uninstalled: true, resolvedPluginId: pluginId });
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
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/files\/search$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, workspace.search(project, searchParams.get("query") || "", searchParams.get("limit") || 20));
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/artifacts$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, workspace.artifacts(project, searchParams.get("limit") || 120));
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/file$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      sendJson(res, 200, workspace.read(project, searchParams.get("path") || ""));
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/file\/download$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      const file = workspace.download(project, searchParams.get("path") || "");
      const fallbackName = file.name.replace(/[^a-z0-9._-]+/gi, "_") || "download";
      res.writeHead(200, {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "content-length": String(file.size),
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      });
      const stream = createReadStream(file.target);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/projects\/(?<id>[^/]+)\/file\/view$/ });
    if (params) {
      const project = findProject(params.id);
      if (!project) return sendError(res, 404, "项目不存在");
      const file = workspace.view(project, searchParams.get("path") || "");
      const fallbackName = file.name.replace(/[^a-z0-9._-]+/gi, "_") || "preview";
      const headers = {
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "content-length": String(file.size),
        "content-type": file.mimeType,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      };
      if (file.kind === "html") {
        headers["content-security-policy"] = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; img-src * data: blob:; font-src data:; media-src * data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
      }
      res.writeHead(200, headers);
      const stream = createReadStream(file.target);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
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
        const preferences = stores.getThreadPreferences(thread.id);
        if (project && preferences?.projectId !== project.id) stores.saveThreadProjectId(thread.id, project.id);
        return decorateThread(thread, {
          archived: isArchived || Boolean(preferences?.archivedLocal),
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
      const list = (serverArchived) => bridge.request("thread/list", {
        limit: 100,
        archived: serverArchived,
        modelProviders: [],
        sourceKinds: threadSourceKinds,
      });
      const activeResult = await list(false);
      const active = filterThreadsByCwd(activeResult, cwd);
      const project = cwd
        ? stores.listProjects().find((item) => normalizeThreadCwd(item.path) === normalizeThreadCwd(cwd))
        : null;
      const rememberProject = (thread) => {
        if (project && stores.getThreadPreferences(thread.id)?.projectId !== project.id) {
          stores.saveThreadProjectId(thread.id, project.id);
        }
        return thread;
      };
      for (const thread of active.data ?? []) rememberProject(thread);
      if (archived) {
        const serverArchived = filterThreadsByCwd(await list(true), cwd);
        for (const thread of serverArchived.data ?? []) rememberProject(thread);
        const unique = new Map();
        for (const thread of serverArchived.data ?? []) {
          if (!stores.getThreadPreferences(thread.id)?.deleted) unique.set(thread.id, decorateThread(thread, { archived: true, storageArchived: true }));
        }
        for (const thread of active.data ?? []) {
          const preferences = stores.getThreadPreferences(thread.id);
          if (preferences?.archivedLocal && !preferences.deleted) unique.set(thread.id, decorateThread(thread, { archived: true, storageArchived: false }));
        }
        sendJson(res, 200, { data: sortThreads([...unique.values()]), nextCursor: null });
        return;
      }
      // Filter after listing. On Windows, Codex persists canonical cwd values
      // with a \\?\ prefix, which does not match thread/list's SQL cwd filter.
      sendJson(res, 200, {
        ...active,
        data: sortThreads(active.data
          ?.filter((thread) => {
            const preferences = stores.getThreadPreferences(thread.id);
            return !preferences?.deleted && !preferences?.archivedLocal;
          })
          .map((thread) => decorateThread(thread, { archived: false, storageArchived: false })) ?? []),
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
      const networkAccess = Object.hasOwn(input, "networkAccess")
        ? Boolean(input.networkAccess)
        : stores.getSettings().networkAccess;
      const result = await bridge.request("thread/start", {
        cwd: project.path,
        modelProvider: modelProviderKey(providerId),
        model: input.model || provider?.model || undefined,
        config: codexRuntimeConfig(readReasoningEffort(input.effort)),
        approvalPolicy,
        sandbox: "workspace-write",
        developerInstructions: composeDeveloperInstructions(stores.getSettings(), project.instructions),
        personality: "friendly",
        serviceName: "codex_fnos_web",
      });
      stores.saveThreadApprovalPolicy(result.thread.id, result.approvalPolicy ?? approvalPolicy);
      stores.saveThreadNetworkAccess(result.thread.id, networkAccess);
      stores.saveThreadProjectId(result.thread.id, project.id);
      sendJson(res, 201, { ...result, thread: decorateThread(result.thread), approvalPolicy: result.approvalPolicy ?? approvalPolicy, networkAccess });
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/threads\/(?<id>[^/]+)\/subagents$/ });
    if (params) {
      const result = await bridge.request("thread/list", {
        limit: 100,
        archived: false,
        ancestorThreadId: params.id,
        modelProviders: [],
      });
      sendJson(res, 200, {
        ...result,
        data: sortThreads((result.data ?? []).map((thread) => decorateThread(thread))),
        join: subagentJoins?.snapshot(params.id) ?? null,
      });
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/threads\/(?<id>[^/]+)$/ });
    if (params) {
      const result = await bridge.request("thread/read", { threadId: params.id, includeTurns: true });
      const project = stores.listProjects().find((item) => normalizeThreadCwd(item.path) === normalizeThreadCwd(result.thread?.cwd));
      if (project) stores.saveThreadProjectId(params.id, project.id);
      sendJson(res, 200, {
        ...result,
        thread: result.thread ? decorateThread(result.thread, { projectId: project?.id }) : result.thread,
      });
      return;
    }
    params = route(req.method, pathname, { method: "DELETE", path: /^\/api\/threads\/(?<id>[^/]+)$/ });
    if (params) {
      outbox?.removeThread(params.id);
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
      const projectId = stores.getThreadPreferences(params.id)?.projectId ?? null;
      const project = projectId ? findProject(projectId) : null;
      const result = await bridge.request("thread/resume", {
        threadId: params.id,
        developerInstructions: composeDeveloperInstructions(stores.getSettings(), project?.instructions),
      });
      const approvalPolicy = stores.getThreadApprovalPolicy(params.id);
      if (approvalPolicy && approvalPolicy !== result.approvalPolicy) {
        await bridge.request("thread/settings/update", { threadId: params.id, approvalPolicy });
      }
      const thread = decorateThread({ ...result.thread, model: result.model, modelProvider: result.modelProvider ?? result.thread?.modelProvider });
      const activeTurn = findActiveTurn(thread);
      if (!activeTurn && subagentJoins) {
        const lastCompletedTurn = [...(thread.turns ?? [])].reverse().find((turn) => turn?.status === "completed");
        await subagentJoins.ensure(params.id, lastCompletedTurn?.id ?? null);
      }
      sendJson(res, 200, {
        ...result,
        thread,
        activeTurnId: activeTurn?.id ?? null,
        activeTurnStartedAt: Number.isFinite(activeTurn?.startedAt) ? activeTurn.startedAt : null,
        model: thread.model ?? result.model,
        modelProvider: thread.modelProvider ?? result.modelProvider,
        approvalPolicy: approvalPolicy ?? result.approvalPolicy,
        networkAccess: stores.getThreadPreferences(params.id)?.networkAccess ?? stores.getSettings().networkAccess,
        subagentJoin: subagentJoins?.snapshot(params.id) ?? null,
      });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/provider$/ });
    if (params) {
      const input = await readJson(req);
      const { providerId, model, effort } = readRetryProvider(input, stores.listProviders());
      const current = await bridge.request("thread/read", { threadId: params.id, includeTurns: false });
      const runtimeModelProvider = String(current.thread?.modelProvider || "");
      const runtimeProviderId = runtimeModelProvider.startsWith("fnos-") ? runtimeModelProvider.slice(5) : null;
      if (runtimeProviderId && !providerId) return sendError(res, 409, "当前聊天使用第三方 API，重试不会切换到未选择的 ChatGPT 官网供应商");
      if (!runtimeProviderId && providerId) return sendError(res, 409, "官方 ChatGPT 聊天不能在原线程内改走第三方 API，请先从模型选择器创建 API 会话");
      const routedModel = runtimeProviderId && providerId !== runtimeProviderId
        ? encodeProviderRoute(providerId, model)
        : model;
      await bridge.request("thread/settings/update", {
        threadId: params.id,
        model: routedModel || undefined,
        effort,
      });
      const thread = decorateThread({ ...current.thread, model: routedModel || current.thread?.model });
      sendJson(res, 200, {
        thread,
        model: thread.model,
        modelProvider: thread.modelProvider,
        reasoningEffort: effort ?? thread.reasoningEffort ?? null,
        approvalPolicy: stores.getThreadApprovalPolicy(params.id),
        networkAccess: stores.getThreadPreferences(params.id)?.networkAccess ?? stores.getSettings().networkAccess,
      });
      return;
    }
    params = route(req.method, pathname, { method: "PATCH", path: /^\/api\/threads\/(?<id>[^/]+)\/settings$/ });
    if (params) {
      const input = await readJson(req);
      const approvalPolicy = readApprovalPolicy(input.approvalPolicy);
      const result = await bridge.request("thread/settings/update", {
        threadId: params.id,
        model: input.model || undefined,
        effort: readReasoningEffort(input.effort),
        approvalPolicy,
      });
      if (approvalPolicy) stores.saveThreadApprovalPolicy(params.id, approvalPolicy);
      if (Object.hasOwn(input, "networkAccess")) stores.saveThreadNetworkAccess(params.id, Boolean(input.networkAccess));
      sendJson(res, 200, { ...result, networkAccess: stores.getThreadPreferences(params.id)?.networkAccess ?? stores.getSettings().networkAccess });
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
      const networkAccess = stores.getThreadPreferences(params.id)?.networkAccess ?? stores.getSettings().networkAccess;
      if (result.thread?.id) stores.saveThreadNetworkAccess(result.thread.id, networkAccess);
      const projectId = stores.getThreadPreferences(params.id)?.projectId ?? null;
      if (result.thread?.id) stores.saveThreadProjectId(result.thread.id, projectId);
      sendJson(res, 201, { ...result, thread: result.thread ? decorateThread(result.thread) : result.thread, approvalPolicy: approvalPolicy ?? result.approvalPolicy, networkAccess });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/archive$/ });
    if (params) {
      outbox?.removeThread(params.id);
      stores.saveThreadArchived(params.id, true);
      sendJson(res, 200, { archived: true, threadId: params.id });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/unarchive$/ });
    if (params) {
      const serverArchived = await bridge.request("thread/list", {
        limit: 100,
        archived: true,
        modelProviders: [],
        sourceKinds: threadSourceKinds,
      });
      let restored = null;
      if ((serverArchived.data ?? []).some((thread) => thread.id === params.id)) {
        restored = await bridge.request("thread/unarchive", { threadId: params.id });
      }
      stores.saveThreadArchived(params.id, false);
      sendJson(res, 200, { archived: false, threadId: params.id, restored });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/turns$/ });
    if (params) {
      const input = await readJson(req, 12 * 1024 * 1024);
      const approvalPolicy = readApprovalPolicy(input.approvalPolicy);
      const project = findProject(input.projectId);
      if (!project) return sendError(res, 404, "当前会话所属项目不存在");
      const networkAccess = Object.hasOwn(input, "networkAccess")
        ? Boolean(input.networkAccess)
        : stores.getThreadPreferences(params.id)?.networkAccess ?? stores.getSettings().networkAccess;
      let availableSkills = [];
      if (Array.isArray(input.skills) && input.skills.length > 0) {
        availableSkills = (await skills.list(project, false)).skills;
      }
      sendJson(res, 202, await bridge.request("turn/start", {
        threadId: params.id,
        clientUserMessageId: input.clientId || randomUUID(),
        input: buildTurnInput(input, availableSkills),
        approvalPolicy,
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [project.path], networkAccess },
        model: input.model || undefined,
        effort: readReasoningEffort(input.effort),
      }));
      if (approvalPolicy) stores.saveThreadApprovalPolicy(params.id, approvalPolicy);
      stores.saveThreadNetworkAccess(params.id, networkAccess);
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/outbox$/ });
    if (params) {
      if (!outbox) return sendError(res, 503, "等待发送服务尚未就绪");
      const input = await readJson(req, 12 * 1024 * 1024);
      const project = findProject(input.projectId);
      if (!project) return sendError(res, 404, "当前会话所属项目不存在");
      let availableSkills = [];
      if (Array.isArray(input.skills) && input.skills.length > 0) {
        availableSkills = (await skills.list(project, false)).skills;
      }
      const prepared = prepareOutboxMessage(input, availableSkills);
      const preferences = stores.getThreadPreferences(params.id);
      const approvalPolicy = readApprovalPolicy(input.approvalPolicy)
        ?? preferences?.approvalPolicy
        ?? stores.getSettings().approvalPolicy;
      const networkAccess = Object.hasOwn(input, "networkAccess")
        ? Boolean(input.networkAccess)
        : preferences?.networkAccess ?? stores.getSettings().networkAccess;
      const message = outbox.enqueue({
        threadId: params.id,
        projectId: project.id,
        ...prepared,
        approvalPolicy,
        networkAccess,
        model: String(input.model || "").trim() || null,
        effort: readReasoningEffort(input.effort),
      });
      sendJson(res, 201, { message });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/threads\/(?<id>[^/]+)\/steer$/ });
    if (params) {
      const input = await readJson(req, 12 * 1024 * 1024);
      const expectedTurnId = typeof input.expectedTurnId === "string" ? input.expectedTurnId.trim() : "";
      if (!expectedTurnId) return sendError(res, 400, "缺少当前任务 ID，无法立即追加消息");
      const project = findProject(input.projectId);
      if (!project) return sendError(res, 404, "当前会话所属项目不存在");
      let availableSkills = [];
      if (Array.isArray(input.skills) && input.skills.length > 0) {
        availableSkills = (await skills.list(project, false)).skills;
      }
      sendJson(res, 202, await bridge.request("turn/steer", {
        threadId: params.id,
        clientUserMessageId: input.clientId || randomUUID(),
        input: buildTurnInput(input, availableSkills),
        expectedTurnId,
      }));
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
      sendJson(res, 200, await accounts.readActive({ refresh: searchParams.get("refresh") === "1" }));
      return;
    }
    if (req.method === "POST" && pathname === "/api/accounts") {
      const profile = await accounts.create(await readJson(req));
      sendJson(res, 201, { profile, accounts: accounts.list(), bridge: bridge.snapshot() });
      return;
    }
    params = route(req.method, pathname, { method: "POST", path: /^\/api\/accounts\/(?<id>[^/]+)\/switch$/ });
    if (params) {
      const profile = await accounts.switchTo(decodeURIComponent(params.id));
      sendJson(res, 200, { profile, accounts: accounts.list(), bridge: bridge.snapshot() });
      return;
    }
    params = route(req.method, pathname, { method: "DELETE", path: /^\/api\/accounts\/(?<id>[^/]+)$/ });
    if (params) {
      sendJson(res, 200, await accounts.delete(decodeURIComponent(params.id)));
      return;
    }
    params = route(req.method, pathname, { method: "GET", path: /^\/api\/account\/login\/(?<id>[^/]+)$/ });
    if (params) {
      const attempt = bridge.loginStatus(params.id);
      if (!attempt) return sendError(res, 404, "登录记录不存在或服务已重启，请重新生成设备码");
      let account = null;
      try {
        account = await accounts.readActive({ refresh: true });
      } catch {
        // Keep the attempt state visible while app-server finishes persisting credentials.
      }
      if (account?.account) {
        sendJson(res, 200, { status: "success", account });
        return;
      }
      if (attempt.status === "error") {
        sendJson(res, 200, { status: "error", error: attempt.error || "ChatGPT 登录失败" });
        return;
      }
      if (attempt.status === "success" && Date.now() - attempt.updatedAt > 8_000) {
        sendJson(res, 200, { status: "error", error: "网页授权已完成，但 NAS 端没有读到登录凭据。请检查 CODEX_HOME 写入权限和应用日志后重试。" });
        return;
      }
      sendJson(res, 200, { status: "pending", browserCompleted: attempt.status === "success" });
      return;
    }
    if (req.method === "POST" && pathname === "/api/account/login") {
      const input = await readJson(req);
      const login = input.type === "apiKey"
        ? { type: "apiKey", apiKey: input.apiKey }
        : { type: "chatgptDeviceCode" };
      try {
        const result = await bridge.request("account/login/start", login);
        if (result?.loginId) bridge.trackLogin(result.loginId);
        sendJson(res, 200, result);
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
      sendJson(res, 200, await accounts.logout());
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

export { buildTurnInput, findActiveTurn, readApprovalPolicy, readReasoningEffort, readRetryProvider };
