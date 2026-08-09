import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { decryptSecret, encryptSecret, secretHint } from "./lib/security.mjs";

const now = () => Math.floor(Date.now() / 1000);

function isFnosStoragePath(value) {
  if (process.platform !== "linux") return false;
  return /^\/vol\d+(?:\/|$)/.test(resolve(value).replaceAll("\\", "/"));
}

function accessibleDirectory(value) {
  try {
    const path = realpathSync(value);
    if (!statSync(path).isDirectory()) return null;
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

function normalizeHeaders(value) {
  if (!value) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("附加请求头必须是对象");
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [String(key).trim(), String(item).trim()])
      .filter(([key]) => key),
  );
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("API 地址必须使用 HTTP 或 HTTPS");
  return url.toString().replace(/\/$/, "");
}

export class Stores {
  constructor(db, masterKey, workspaceRoots, workspaceCandidates = []) {
    this.db = db;
    this.masterKey = masterKey;
    this.baseWorkspaceRoots = [...new Set(workspaceRoots.map((item) => resolve(item)))];
    this.workspaceCandidates = [...new Set(workspaceCandidates.map((item) => resolve(item)))];
    let savedRoots = [];
    try {
      savedRoots = JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key = 'workspace_roots'").get()?.value || "[]");
    } catch {
      savedRoots = [];
    }
    const restoredRoots = savedRoots.flatMap((item) => {
      const requested = resolve(item);
      if (!this.workspaceCandidates.includes(requested) && !isFnosStoragePath(requested)) return [];
      const accessible = accessibleDirectory(requested);
      return accessible && (this.workspaceCandidates.includes(requested) || isFnosStoragePath(accessible)) ? [accessible] : [];
    });
    this.workspaceRoots = [...new Set([...this.baseWorkspaceRoots, ...restoredRoots])];
  }

  listProxies() {
    return this.db.prepare("SELECT * FROM proxy_profiles ORDER BY updated_at DESC").all().map((row) => ({
      id: row.id,
      name: row.name,
      httpUrlHint: row.http_url_hint || (row.kind === "http" ? row.url_hint : null),
      httpsUrlHint: row.https_url_hint || (row.kind === "https" ? row.url_hint : null),
      socks5UrlHint: row.socks5_url_hint || (row.kind === "socks5" ? row.url_hint : null),
      noProxy: row.no_proxy,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getProxySecret(id) {
    const row = this.db.prepare("SELECT * FROM proxy_profiles WHERE id = ?").get(id);
    if (!row) return null;
    const legacyUrl = decryptSecret(row.url_encrypted, this.masterKey);
    return {
      ...row,
      http_url: decryptSecret(row.http_url_encrypted, this.masterKey) || (row.kind === "http" ? legacyUrl : ""),
      https_url: decryptSecret(row.https_url_encrypted, this.masterKey) || (row.kind === "https" ? legacyUrl : ""),
      socks5_url: decryptSecret(row.socks5_url_encrypted, this.masterKey) || (row.kind === "socks5" ? legacyUrl : ""),
    };
  }

  saveProxy(input, id = randomUUID()) {
    const existing = this.db.prepare("SELECT * FROM proxy_profiles WHERE id = ?").get(id);
    const existingSecret = existing ? this.getProxySecret(id) : null;
    let httpInput = input.httpUrl;
    let httpsInput = input.httpsUrl;
    let socks5Input = input.socks5Url;
    if (httpInput === undefined && httpsInput === undefined && socks5Input === undefined && input.url !== undefined) {
      if (input.kind === "https") httpsInput = input.url;
      else if (input.kind === "socks5") socks5Input = input.url;
      else if (input.kind !== "direct") httpInput = input.url;
    }
    const httpUrl = httpInput === undefined ? existingSecret?.http_url ?? "" : String(httpInput).trim();
    const httpsUrl = httpsInput === undefined ? existingSecret?.https_url ?? "" : String(httpsInput).trim();
    const socks5Url = socks5Input === undefined ? existingSecret?.socks5_url ?? "" : String(socks5Input).trim();
    for (const [label, value, protocols] of [
      ["HTTP", httpUrl, ["http:", "https:"]],
      ["HTTPS", httpsUrl, ["http:", "https:"]],
      ["SOCKS5", socks5Url, ["socks5:", "socks5h:"]],
    ]) {
      if (!value) continue;
      if (!protocols.includes(new URL(value).protocol)) throw new Error(`${label} 代理地址协议不正确`);
    }
    if (!httpUrl && !httpsUrl && !socks5Url) throw new Error("HTTP、HTTPS、SOCKS5 代理至少填写一个");
    const [kind, legacyUrl] = httpUrl
      ? ["http", httpUrl]
      : httpsUrl
        ? ["https", httpsUrl]
        : ["socks5", socks5Url];
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO proxy_profiles (
        id, name, kind, url_encrypted, url_hint,
        http_url_encrypted, http_url_hint, https_url_encrypted, https_url_hint,
        socks5_url_encrypted, socks5_url_hint, no_proxy, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, kind = excluded.kind, url_encrypted = excluded.url_encrypted,
        url_hint = excluded.url_hint, http_url_encrypted = excluded.http_url_encrypted,
        http_url_hint = excluded.http_url_hint, https_url_encrypted = excluded.https_url_encrypted,
        https_url_hint = excluded.https_url_hint, socks5_url_encrypted = excluded.socks5_url_encrypted,
        socks5_url_hint = excluded.socks5_url_hint, no_proxy = excluded.no_proxy,
        enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(
      id,
      String(input.name ?? existing?.name ?? "代理").trim(),
      kind,
      encryptSecret(legacyUrl, this.masterKey),
      this.maskProxyUrl(legacyUrl),
      encryptSecret(httpUrl, this.masterKey),
      httpUrl ? this.maskProxyUrl(httpUrl) : null,
      encryptSecret(httpsUrl, this.masterKey),
      httpsUrl ? this.maskProxyUrl(httpsUrl) : null,
      encryptSecret(socks5Url, this.masterKey),
      socks5Url ? this.maskProxyUrl(socks5Url) : null,
      String(input.noProxy ?? existing?.no_proxy ?? "127.0.0.1,localhost").trim(),
      input.enabled === false ? 0 : 1,
      existing?.created_at ?? timestamp,
      timestamp,
    );
    return this.listProxies().find((item) => item.id === id);
  }

  deleteProxy(id) {
    const deleteProxy = this.db.prepare("DELETE FROM proxy_profiles WHERE id = ?");
    const clearDefault = this.db.prepare(`
      UPDATE settings SET value = '' WHERE key = 'default_proxy_id' AND value = ?
    `);
    const clearProviders = this.db.prepare(`
      UPDATE provider_profiles SET proxy_profile_id = NULL, proxy_mode = 'inherit' WHERE proxy_profile_id = ?
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      clearProviders.run(id);
      const deleted = deleteProxy.run(id).changes > 0;
      if (deleted) clearDefault.run(id);
      this.db.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSettings() {
    const rows = this.db.prepare("SELECT key, value FROM settings").all();
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      defaultProxyId: values.default_proxy_id || null,
      workspaceRoots: [...this.workspaceRoots],
      approvalPolicy: values.approval_policy === "never" ? "never" : "on-request",
      theme: ["system", "light", "dark", "ink"].includes(values.theme) ? values.theme : "system",
      backgroundEnabled: values.background_enabled !== "false",
      backgroundOpacity: Math.min(0.85, Math.max(0.05, Number(values.background_opacity) || 0.35)),
    };
  }

  saveSettings(input) {
    if ("defaultProxyId" in input) {
      const value = input.defaultProxyId || "";
      if (value && !this.getProxySecret(value)) throw new Error("默认代理不存在");
      this.db.prepare(`
        INSERT INTO settings (key, value) VALUES ('default_proxy_id', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(value);
    }
    if ("approvalPolicy" in input) {
      if (!["on-request", "never"].includes(input.approvalPolicy)) throw new Error("命令审批方式无效");
      this.#saveSetting("approval_policy", input.approvalPolicy);
    }
    if ("theme" in input) {
      if (!["system", "light", "dark", "ink"].includes(input.theme)) throw new Error("主题设置无效");
      this.#saveSetting("theme", input.theme);
    }
    if ("backgroundEnabled" in input) this.#saveSetting("background_enabled", input.backgroundEnabled ? "true" : "false");
    if ("backgroundOpacity" in input) {
      const opacity = Number(input.backgroundOpacity);
      if (!Number.isFinite(opacity) || opacity < 0.05 || opacity > 0.85) throw new Error("背景强度必须在 5% 到 85% 之间");
      this.#saveSetting("background_opacity", String(opacity));
    }
    return this.getSettings();
  }

  listWorkspaceCandidates() {
    return this.workspaceCandidates.map((path) => ({ path, enabled: this.workspaceRoots.includes(path) }));
  }

  addWorkspaceRoot(value) {
    const input = resolve(String(value || ""));
    const requested = accessibleDirectory(input);
    if (!requested) throw Object.assign(new Error("应用账号无法读写这个目录，请确认目录存在并已在飞牛中授予读写权限"), { status: 403 });
    const discovered = this.workspaceCandidates.includes(input) || this.workspaceCandidates.includes(requested);
    if (!discovered && (!isFnosStoragePath(input) || !isFnosStoragePath(requested))) {
      throw Object.assign(new Error("只能添加飞牛存储卷中已授权的目录"), { status: 403 });
    }
    this.workspaceRoots = [...new Set([...this.workspaceRoots, requested])];
    this.#saveSetting("workspace_roots", JSON.stringify(this.workspaceRoots.filter((item) => !this.baseWorkspaceRoots.includes(item))));
    return this.getSettings();
  }

  #saveSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  getEffectiveProxy(provider) {
    if (provider.proxy_mode === "direct") return null;
    const id = provider.proxy_mode === "profile"
      ? provider.proxy_profile_id
      : this.getSettings().defaultProxyId;
    return id ? this.getProxySecret(id) : null;
  }

  listProviders() {
    return this.db.prepare("SELECT * FROM provider_profiles ORDER BY updated_at DESC").all().map((row) => ({
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      baseUrl: row.base_url,
      model: row.model,
      apiKeyHint: row.api_key_hint,
      hasApiKey: Boolean(row.api_key_encrypted),
      hasCustomHeaders: Boolean(row.headers_encrypted),
      proxyProfileId: row.proxy_profile_id,
      proxyMode: row.proxy_mode || (row.proxy_profile_id ? "profile" : "inherit"),
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getProviderSecret(id) {
    const row = this.db.prepare("SELECT * FROM provider_profiles WHERE id = ?").get(id);
    if (!row) return null;
    return {
      ...row,
      apiKey: decryptSecret(row.api_key_encrypted, this.masterKey),
      headers: JSON.parse(decryptSecret(row.headers_encrypted, this.masterKey) || "{}"),
    };
  }

  saveProvider(input, id = randomUUID()) {
    const existing = this.db.prepare("SELECT * FROM provider_profiles WHERE id = ?").get(id);
    const apiKey = input.apiKey === undefined
      ? decryptSecret(existing?.api_key_encrypted, this.masterKey)
      : String(input.apiKey).trim();
    const headers = input.headers === undefined
      ? JSON.parse(decryptSecret(existing?.headers_encrypted, this.masterKey) || "{}")
      : normalizeHeaders(input.headers);
    const protocol = input.protocol ?? existing?.protocol ?? "responses";
    if (!["responses", "chat_completions"].includes(protocol)) throw new Error("不支持的 API 协议");
    const model = String(input.model ?? existing?.model ?? "").trim();
    if (!model) throw new Error("模型名称不能为空");
    let proxyMode = input.proxyMode ?? existing?.proxy_mode ?? (existing?.proxy_profile_id ? "profile" : "inherit");
    let proxyProfileId = input.proxyProfileId === undefined ? existing?.proxy_profile_id ?? null : input.proxyProfileId || null;
    if (input.proxyMode === undefined && Object.hasOwn(input, "proxyProfileId")) proxyMode = proxyProfileId ? "profile" : "inherit";
    if (!["inherit", "direct", "profile"].includes(proxyMode)) throw new Error("供应商代理模式无效");
    if (proxyMode !== "profile") proxyProfileId = null;
    if (proxyMode === "profile" && !this.getProxySecret(proxyProfileId)) throw new Error("供应商代理配置不存在");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO provider_profiles (
        id, name, protocol, base_url, model, api_key_encrypted, api_key_hint,
        headers_encrypted, proxy_profile_id, proxy_mode, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, protocol = excluded.protocol, base_url = excluded.base_url,
        model = excluded.model, api_key_encrypted = excluded.api_key_encrypted,
        api_key_hint = excluded.api_key_hint, headers_encrypted = excluded.headers_encrypted,
        proxy_profile_id = excluded.proxy_profile_id, proxy_mode = excluded.proxy_mode,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      id,
      String(input.name ?? existing?.name ?? "自定义供应商").trim(),
      protocol,
      normalizeBaseUrl(input.baseUrl ?? existing?.base_url),
      model,
      encryptSecret(apiKey, this.masterKey),
      secretHint(apiKey),
      encryptSecret(JSON.stringify(headers), this.masterKey),
      proxyProfileId,
      proxyMode,
      input.enabled === false ? 0 : 1,
      existing?.created_at ?? timestamp,
      timestamp,
    );
    return this.listProviders().find((item) => item.id === id);
  }

  deleteProvider(id) {
    return this.db.prepare("DELETE FROM provider_profiles WHERE id = ?").run(id).changes > 0;
  }

  listProjects() {
    return this.db.prepare("SELECT * FROM projects ORDER BY pinned DESC, updated_at DESC").all().map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      defaultProviderId: row.default_provider_id,
      instructions: row.instructions,
      pinned: Boolean(row.pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  saveProject(input, id = randomUUID()) {
    const existing = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    const path = this.resolveProjectPath(input.path ?? existing?.path, input.create !== false);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO projects (id, name, path, default_provider_id, instructions, pinned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path,
        default_provider_id = excluded.default_provider_id, instructions = excluded.instructions,
        pinned = excluded.pinned, updated_at = excluded.updated_at
    `).run(
      id,
      String(input.name ?? existing?.name ?? path.split(/[\\/]/).at(-1)).trim(),
      path,
      input.defaultProviderId || null,
      String(input.instructions ?? existing?.instructions ?? ""),
      input.pinned ? 1 : 0,
      existing?.created_at ?? timestamp,
      timestamp,
    );
    return this.listProjects().find((item) => item.id === id);
  }

  deleteProject(id) {
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  browseDirectories(value) {
    const requested = resolve(value || this.workspaceRoots[0]);
    if (!existsSync(requested)) throw new Error("目录不存在");
    const path = realpathSync(requested);
    if (!this.isAllowedPath(path)) throw new Error("目录不在允许的工作区内");
    const parentCandidate = dirname(path);
    const parent = parentCandidate !== path && this.isAllowedPath(parentCandidate)
      ? parentCandidate
      : null;
    const entries = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("@"))
      .map((entry) => {
        const entryPath = resolve(path, entry.name);
        try {
          const realEntryPath = realpathSync(entryPath);
          return this.isAllowedPath(realEntryPath) ? { name: entry.name, path: realEntryPath } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    return { path, parent, roots: [...this.workspaceRoots], entries };
  }

  resolveProjectPath(value, create) {
    if (!value || !isAbsolute(value)) throw new Error("项目目录必须是绝对路径");
    const target = resolve(value);
    const checkedTarget = existsSync(target)
      ? realpathSync(target)
      : resolve(realpathSync(dirname(target)), basename(target));
    if (!this.isAllowedPath(checkedTarget)) throw new Error(`项目目录不在允许的工作区内：${this.workspaceRoots.join(", ")}`);
    if (create) mkdirSync(checkedTarget, { recursive: true });
    if (!existsSync(checkedTarget)) throw new Error("项目目录不存在");
    return realpathSync(checkedTarget);
  }

  maskProxyUrl(value) {
    const url = new URL(value);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString().replace(/\/$/, "");
  }

  isAllowedPath(target) {
    return this.workspaceRoots.some((root) => {
      const rest = relative(root, target);
      return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
    });
  }
}
