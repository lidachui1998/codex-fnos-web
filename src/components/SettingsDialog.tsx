import { BellRing, CheckCircle2, Clock3, CloudCog, Download, Gauge, Image as ImageIcon, KeyRound, LoaderCircle, Network, Palette, Pencil, PlugZap, Plus, RefreshCw, ShieldCheck, Trash2, Upload, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { reasoningProfileName } from "../reasoning-profile";
import type { Bootstrap, CodexUpdateState, ProviderProfile, ProxyProfile, RateLimitSnapshot, RateLimitWindow, ReasoningProfile } from "../types";
import { ModelCombobox } from "./ModelCombobox";
import { Modal } from "./Modal";
import { NotificationSettings } from "./NotificationSettings";
import { PersonalizationSettings } from "./PersonalizationSettings";

type Props = {
  open: boolean;
  bootstrap: Bootstrap;
  onClose: () => void;
  onChanged: () => Promise<void>;
};

type ProviderForm = {
  name: string;
  protocol: ProviderProfile["protocol"];
  baseUrl: string;
  model: string;
  apiKey: string;
  proxyMode: ProviderProfile["proxyMode"];
  reasoningProfile: ReasoningProfile;
  proxyProfileId: string;
  headers: string;
};

type ProxyForm = {
  name: string;
  httpUrl: string;
  httpsUrl: string;
  socks5Url: string;
  noProxy: string;
};

const emptyProvider: ProviderForm = {
  name: "",
  protocol: "responses" as const,
  baseUrl: "",
  model: "",
  apiKey: "",
  proxyMode: "inherit",
  reasoningProfile: "auto",
  proxyProfileId: "",
  headers: "{}",
};

const emptyProxy: ProxyForm = {
  name: "",
  httpUrl: "",
  httpsUrl: "",
  socks5Url: "",
  noProxy: "127.0.0.1,localhost,::1",
};

const planNames: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_prolite: "Business Pro Lite",
  self_serve_business_usage_based: "Business 按量",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise Automation",
  enterprise_cbp_usage_based: "Enterprise 按量",
  enterprise: "Enterprise",
  edu: "Edu",
  unknown: "未知套餐",
};

function planName(value?: string | null) {
  return value ? planNames[value] || value : "套餐未知";
}

function windowName(window: RateLimitWindow, fallback: string) {
  const minutes = Number(window.windowDurationMins || 0);
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}

function resetTime(value?: number | null) {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "等待官方返回";
}

function rateLimitEntries(bootstrap: Bootstrap) {
  const limits = bootstrap.account?.rateLimits;
  if (!limits) return [];
  const entries = Object.entries(limits.rateLimitsByLimitId || {});
  const root = limits.rateLimits;
  const rootId = root?.limitId || "legacy";
  if (root && !entries.some(([limitId, snapshot]) => limitId === rootId || snapshot.limitId === root.limitId)) {
    entries.push([rootId, root]);
  }
  return entries;
}

function usageSnapshot(bootstrap: Bootstrap): RateLimitSnapshot | null {
  const limits = bootstrap.account?.rateLimits;
  if (!limits) return null;
  if (limits.codexRateLimits) return limits.codexRateLimits;
  const entries = Object.entries(limits.rateLimitsByLimitId || {});
  const keyed = entries.find(([limitId]) => limitId.toLowerCase() === "codex")?.[1];
  if (keyed) return keyed;
  const identified = entries.find(([, snapshot]) => snapshot.limitId?.toLowerCase() === "codex")?.[1];
  if (identified) return identified;
  return limits.rateLimits?.limitId?.toLowerCase() === "codex" ? limits.rateLimits : null;
}

function exhaustionReason(bootstrap: Bootstrap) {
  for (const [, snapshot] of rateLimitEntries(bootstrap)) {
    if (snapshot.rateLimitReachedType) return snapshot.rateLimitReachedType;
    if (snapshot.spendControlReached) return "spendControlReached";
    if (snapshot.individualLimit && Number(snapshot.individualLimit.remainingPercent) <= 0) return "individualLimitReached";
  }
  return null;
}

function usageState(snapshot: RateLimitSnapshot, window: RateLimitWindow) {
  const exhausted = Boolean(
    snapshot.rateLimitReachedType
    || snapshot.spendControlReached
    || (snapshot.individualLimit && Number(snapshot.individualLimit.remainingPercent) <= 0),
  );
  if (exhausted) return { usedPercent: 100, label: "已耗尽" };
  const raw = Number(window.usedPercent);
  if (!Number.isFinite(raw)) return { usedPercent: null, label: "状态未知" };
  const usedPercent = Math.min(100, Math.max(0, raw));
  return { usedPercent, label: `官方已用 ${usedPercent}% · 剩余 ${Math.max(0, 100 - usedPercent)}%` };
}

export function SettingsDialog({ open, bootstrap, onClose, onChanged }: Props) {
  const [tab, setTab] = useState<"providers" | "proxies" | "permissions" | "notifications" | "personalization" | "appearance" | "updates" | "account">("providers");
  const [providerForm, setProviderForm] = useState(emptyProvider);
  const [proxyForm, setProxyForm] = useState(emptyProxy);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editingProxy, setEditingProxy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [deviceLogin, setDeviceLogin] = useState<{ loginId: string; verificationUrl: string; userCode: string; status: "pending" | "browserCompleted" | "error"; error?: string } | null>(null);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [updateInfo, setUpdateInfo] = useState<CodexUpdateState>(bootstrap.codex);

  useEffect(() => {
    if (!open) {
      setNotice("");
      setError("");
    }
  }, [open]);

  useEffect(() => { setUpdateInfo(bootstrap.codex); }, [bootstrap.codex]);

  useEffect(() => {
    if (open && tab === "account") void onChanged();
  }, [onChanged, open, tab]);

  useEffect(() => {
    if (!open || !deviceLogin || deviceLogin.status === "error") return;
    let cancelled = false;
    const startedAt = Date.now();
    const poll = async () => {
      try {
        const result = await api<{ status: "pending" | "success" | "error"; browserCompleted?: boolean; error?: string }>(`/api/account/login/${encodeURIComponent(deviceLogin.loginId)}`);
        if (cancelled) return;
        if (result.status === "success") {
          setNotice("ChatGPT 账户已在 NAS 端验证并连接");
          setDeviceLogin(null);
          await onChanged();
          return;
        }
        if (result.status === "error") {
          setDeviceLogin((current) => current ? { ...current, status: "error", error: result.error || "登录失败" } : current);
          return;
        }
        const nextStatus = result.browserCompleted ? "browserCompleted" : "pending";
        setDeviceLogin((current) => current && current.status !== nextStatus ? { ...current, status: nextStatus } : current);
        if (Date.now() - startedAt > 10 * 60_000) {
          setDeviceLogin((current) => current ? { ...current, status: "error", error: "等待登录超时，请重新生成设备码" } : current);
        }
      } catch (reason) {
        if (!cancelled) setDeviceLogin((current) => current ? { ...current, status: "error", error: reason instanceof Error ? reason.message : "登录状态检查失败" } : current);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, deviceLogin?.loginId, deviceLogin?.status]);

  async function checkCodexUpdate() {
    setBusy("check-update"); setError(""); setNotice("");
    try {
      const result = await api<CodexUpdateState>("/api/codex/update");
      setUpdateInfo(result);
      setNotice(result.updateAvailable ? `发现 Codex ${result.latestVersion}` : `当前已是最新版本 ${result.currentVersion}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "检查更新失败"); }
    finally { setBusy(null); }
  }

  async function uploadBackground(file?: File) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setError("背景图片不能超过 8 MB"); return; }
    await perform("upload-background", async () => {
      await api("/api/appearance/background", { method: "POST", headers: { "content-type": file.type }, body: file });
      await api("/api/settings", { method: "PATCH", body: JSON.stringify({ backgroundEnabled: true }) });
    }, "背景图片已更新并启用");
  }

  async function perform(label: string, action: () => Promise<unknown>, success: string) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
      await onChanged();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function changeDefaultProxy(proxyId: string) {
    setBusy("default-proxy"); setError(""); setNotice("");
    try {
      if (proxyId) await api(`/api/proxies/${proxyId}/test`, { method: "POST", body: "{}" });
      await api("/api/settings", { method: "PATCH", body: JSON.stringify({ defaultProxyId: proxyId || null }) });
      setNotice(proxyId ? "代理已从 NAS 侧测试通过，Codex 服务正在重载" : "已切换为直连，并清除 Codex 子进程继承的旧代理");
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? `${reason.message}。如果代理运行在电脑上，请开启“允许局域网连接”并放行防火墙端口。` : "代理测试失败");
    } finally { setBusy(null); }
  }

  function editProvider(provider: ProviderProfile) {
    setEditingProvider(provider.id);
    setProviderForm({
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "",
      proxyMode: provider.proxyMode,
      reasoningProfile: provider.reasoningProfile,
      proxyProfileId: provider.proxyProfileId ?? "",
      headers: "{}",
    });
    setProviderModels([]);
  }

  function readProviderHeaders() {
    try {
      const headers = JSON.parse(providerForm.headers || "{}");
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error();
      return headers as Record<string, string>;
    } catch {
      setError("附加请求头必须是有效的 JSON 对象");
      return null;
    }
  }

  async function fetchProviderModels() {
    if (!providerForm.baseUrl.trim()) {
      setError("请先填写供应商 Base URL");
      return;
    }
    const headers = readProviderHeaders();
    if (!headers) return;
    setBusy("provider-models");
    setError("");
    setNotice("");
    try {
      const result = await api<{ data: Array<{ model: string }>; source: string }>("/api/providers/models", {
        method: "POST",
        body: JSON.stringify({
          ...providerForm,
          providerId: editingProvider,
          apiKey: providerForm.apiKey || undefined,
          headers,
        }),
      });
      const models = result.data.map((item) => item.model);
      setProviderModels(models);
      if (!providerForm.model && models[0]) setProviderForm((current) => ({ ...current, model: models[0] }));
      setNotice(`已从 ${result.source} 获取 ${models.length} 个模型`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型列表获取失败");
    } finally {
      setBusy(null);
    }
  }

  function editProxy(proxy: ProxyProfile) {
    setEditingProxy(proxy.id);
    setProxyForm({
      name: proxy.name,
      httpUrl: "",
      httpsUrl: "",
      socks5Url: "",
      noProxy: proxy.noProxy,
    });
  }

  function addAccount() {
    const label = window.prompt("给这个账户写一个备注，方便切换", `账户 ${bootstrap.accounts.length + 1}`);
    if (label === null) return;
    setDeviceLogin(null);
    void perform("account-add", () => api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ label: label.trim() || `账户 ${bootstrap.accounts.length + 1}` }),
    }), "已创建并切换到新账户，请完成登录");
  }

  function switchAccount(id: string) {
    if (id === bootstrap.activeAccountId) return;
    setDeviceLogin(null);
    void perform(`account-switch:${id}`, () => api(`/api/accounts/${encodeURIComponent(id)}/switch`, {
      method: "POST",
      body: "{}",
    }), "Codex 账户已切换");
  }

  function deleteAccount(profile: Bootstrap["accounts"][number]) {
    if (!window.confirm(`删除账户“${profile.label}”？凭据目录会移入可恢复的隔离区，不会直接擦除。`)) return;
    setDeviceLogin(null);
    void perform(`account-delete:${profile.id}`, () => api(`/api/accounts/${encodeURIComponent(profile.id)}`, {
      method: "DELETE",
    }), "账户已删除，原凭据目录已移入隔离区");
  }

  return (
    <Modal open={open} onClose={onClose} title="工作台设置" subtitle="模型、代理和账户都保存在这台飞牛设备上。" wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <button className={tab === "providers" ? "active" : ""} onClick={() => setTab("providers")}>
            <CloudCog size={17} /> 模型供应商
          </button>
          <button className={tab === "proxies" ? "active" : ""} onClick={() => setTab("proxies")}>
            <Network size={17} /> 网络代理
          </button>
          <button className={tab === "permissions" ? "active" : ""} onClick={() => setTab("permissions")}>
            <ShieldCheck size={17} /> 命令审批
          </button>
          <button className={tab === "notifications" ? "active" : ""} onClick={() => setTab("notifications")}>
            <BellRing size={17} /> 通知设置
          </button>
          <button className={tab === "personalization" ? "active" : ""} onClick={() => setTab("personalization")}>
            <UserRound size={17} /> 个性化指令
          </button>
          <button className={tab === "appearance" ? "active" : ""} onClick={() => setTab("appearance")}>
            <Palette size={17} /> 外观主题
          </button>
          <button className={tab === "updates" ? "active" : ""} onClick={() => setTab("updates")}>
            <Download size={17} /> Codex 更新
          </button>
          <button className={tab === "account" ? "active" : ""} onClick={() => setTab("account")}>
            <KeyRound size={17} /> OpenAI 账户
          </button>
        </nav>

        <section className="settings-content">
          {notice && <div className="success-banner"><CheckCircle2 size={16} /> {notice}</div>}
          {error && <div className="form-error">{error}</div>}

          {tab === "providers" && (
            <div className="settings-section">
              <div className="section-heading">
                <div><h3>第三方 API</h3><p>Responses 原生直通；Chat Completions 由本地兼容层转换。</p></div>
              </div>
              <div className="settings-list">
                {bootstrap.providers.map((provider) => (
                  <article className="settings-row" key={provider.id}>
                    <div className="provider-avatar">{provider.name.slice(0, 1).toUpperCase()}</div>
                    <div className="settings-row-main">
                      <strong>{provider.name}</strong>
                      <span>{provider.model} · {provider.protocol === "responses" ? "Responses" : "Chat Completions"}</span>
                      <small>{provider.baseUrl} · {provider.apiKeyHint || "无需密钥"}</small>
                    </div>
                    <div className="row-actions">
                      <button className="mini-button" onClick={() => perform(`test-provider-${provider.id}`, () => api(`/api/providers/${provider.id}/test`, { method: "POST", body: "{}" }), "供应商连接测试成功")}>{busy === `test-provider-${provider.id}` ? "测试中" : "测试"}</button>
                      <button className="icon-button small" onClick={() => editProvider(provider)} aria-label={`编辑 ${provider.name}`}><Pencil size={15} /></button>
                      <button className="icon-button small danger" onClick={() => perform(`delete-provider-${provider.id}`, () => api(`/api/providers/${provider.id}`, { method: "DELETE" }), "供应商已删除")} aria-label={`删除 ${provider.name}`}><Trash2 size={15} /></button>
                    </div>
                  </article>
                ))}
                {bootstrap.providers.length === 0 && <div className="empty-inline">还没有第三方供应商，先在下方添加一个。</div>}
              </div>

              <form className="settings-form" onSubmit={(event) => {
                event.preventDefault();
                const path = editingProvider ? `/api/providers/${editingProvider}` : "/api/providers";
                const method = editingProvider ? "PATCH" : "POST";
                const headers = readProviderHeaders();
                if (!headers) return;
                perform("save-provider", () => api(path, {
                  method,
                  body: JSON.stringify({ ...providerForm, apiKey: providerForm.apiKey || undefined, headers }),
                }), editingProvider ? "供应商已更新，Codex 服务正在重载" : "供应商已添加，Codex 服务正在重载").then((saved) => {
                  if (!saved) return;
                  setEditingProvider(null);
                  setProviderForm(emptyProvider);
                  setProviderModels([]);
                });
              }}>
                <h4>{editingProvider ? "编辑供应商" : "添加供应商"}</h4>
                <div className="form-grid two">
                  <label><span>名称</span><input required value={providerForm.name} onChange={(event) => setProviderForm({ ...providerForm, name: event.target.value })} placeholder="例如：New API" /></label>
                  <label><span>接口协议</span><select value={providerForm.protocol} onChange={(event) => setProviderForm({ ...providerForm, protocol: event.target.value as typeof providerForm.protocol })}><option value="responses">Responses API</option><option value="chat_completions">Chat Completions 兼容</option></select></label>
                  <label className="span-two"><span>Base URL</span><input required value={providerForm.baseUrl} onChange={(event) => { setProviderForm({ ...providerForm, baseUrl: event.target.value }); setProviderModels([]); }} placeholder="https://api.example.com/v1" /></label>
                  <label><span>API Key</span><input type="password" value={providerForm.apiKey} onChange={(event) => { setProviderForm({ ...providerForm, apiKey: event.target.value }); setProviderModels([]); }} placeholder={editingProvider ? "留空则使用已保存的密钥" : "可留空"} /></label>
                  <label><span>连接方式</span><select value={providerForm.proxyMode === "profile" ? `profile:${providerForm.proxyProfileId}` : providerForm.proxyMode} onChange={(event) => {
                    const value = event.target.value;
                    setProviderForm({
                      ...providerForm,
                      proxyMode: value.startsWith("profile:") ? "profile" : value as ProviderProfile["proxyMode"],
                      proxyProfileId: value.startsWith("profile:") ? value.slice(8) : "",
                    });
                  }}><option value="inherit">继承应用默认代理</option><option value="direct">直连（不使用应用代理）</option>{bootstrap.proxies.map((proxy) => <option key={proxy.id} value={`profile:${proxy.id}`}>使用代理：{proxy.name}</option>)}</select></label>
                  <label><span>思考档位类型</span><select value={providerForm.reasoningProfile} onChange={(event) => setProviderForm({ ...providerForm, reasoningProfile: event.target.value as ReasoningProfile })}>{(["auto", "openai", "anthropic", "deepseek", "qwen", "kimi", "glm", "gemini", "generic", "none"] as ReasoningProfile[]).map((profile) => <option key={profile} value={profile}>{reasoningProfileName(profile)}</option>)}</select><small>自动识别不准确时可手工指定。</small></label>
                  <label className="span-two"><span>模型 ID</span><div className="provider-model-field"><ModelCombobox required options={providerModels.map((model) => ({ value: model }))} value={providerForm.model} onChange={(model) => setProviderForm({ ...providerForm, model })} placeholder="先从 /models 获取，或手动输入" /><button type="button" className="secondary-button" onClick={() => void fetchProviderModels()} disabled={busy === "provider-models"}>{busy === "provider-models" ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} 从 /models 获取</button></div>{providerModels.length > 0 && <span className="provider-model-count">已获取 {providerModels.length} 个模型，点击右侧箭头下拉选择，也可输入关键字筛选</span>}</label>
                  <label className="span-two"><span>附加请求头（JSON）</span><textarea rows={3} value={providerForm.headers} onChange={(event) => setProviderForm({ ...providerForm, headers: event.target.value })} /></label>
                </div>
                <div className="form-actions"><button type="button" className="ghost-button" onClick={() => { setEditingProvider(null); setProviderForm(emptyProvider); setProviderModels([]); }}>清空</button><button className="primary-button" disabled={busy === "save-provider"}><PlugZap size={16} /> {editingProvider ? "保存修改" : "添加供应商"}</button></div>
              </form>
            </div>
          )}

          {tab === "proxies" && (
            <div className="settings-section">
              <div className="section-heading"><div><h3>网络代理</h3><p>仅供本 Codex 工作台使用，不会修改飞牛 NAS 或其他应用的系统代理；每个模型供应商还可以独立覆盖。</p></div></div>
              <label className="default-proxy"><span>应用默认代理</span><select value={bootstrap.settings.defaultProxyId ?? ""} disabled={busy === "default-proxy"} onChange={(event) => void changeDefaultProxy(event.target.value)}><option value="">直连</option>{bootstrap.proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name}</option>)}</select></label>
              <div className="settings-warning">选择默认代理时会先从 NAS 侧测试连通性；失败的代理不会启用。代理只注入本应用和它启动的 Codex 命令，不会修改 fnOS 系统代理。电脑上的代理必须监听局域网地址（不是仅 127.0.0.1），并放行对应防火墙端口。</div>
              <div className="settings-list">
                {bootstrap.proxies.map((proxy) => (
                  <article className="settings-row" key={proxy.id}>
                    <div className="provider-avatar proxy"><Network size={17} /></div>
                    <div className="settings-row-main"><strong>{proxy.name}</strong><span>{[
                      proxy.httpUrlHint && `HTTP ${proxy.httpUrlHint}`,
                      proxy.httpsUrlHint && `HTTPS ${proxy.httpsUrlHint}`,
                      proxy.socks5UrlHint && `SOCKS5 ${proxy.socks5UrlHint}`,
                    ].filter(Boolean).join(" · ")}</span><small>直连名单：{proxy.noProxy || "未设置"}</small></div>
                    <div className="row-actions"><button className="mini-button" onClick={() => perform(`test-proxy-${proxy.id}`, () => api(`/api/proxies/${proxy.id}/test`, { method: "POST", body: "{}" }), "代理链路测试成功")}>{busy === `test-proxy-${proxy.id}` ? "测试中" : "测试"}</button><button className="icon-button small" onClick={() => editProxy(proxy)} aria-label={`编辑 ${proxy.name}`}><Pencil size={15} /></button><button className="icon-button small danger" onClick={() => perform(`delete-proxy-${proxy.id}`, () => api(`/api/proxies/${proxy.id}`, { method: "DELETE" }), "代理已删除")} aria-label={`删除 ${proxy.name}`}><Trash2 size={15} /></button></div>
                  </article>
                ))}
              </div>
              <form className="settings-form" onSubmit={(event) => {
                event.preventDefault();
                const path = editingProxy ? `/api/proxies/${editingProxy}` : "/api/proxies";
                perform("save-proxy", () => api(path, {
                  method: editingProxy ? "PATCH" : "POST",
                  body: JSON.stringify({
                    ...proxyForm,
                    httpUrl: proxyForm.httpUrl || (editingProxy ? undefined : ""),
                    httpsUrl: proxyForm.httpsUrl || (editingProxy ? undefined : ""),
                    socks5Url: proxyForm.socks5Url || (editingProxy ? undefined : ""),
                  }),
                }), editingProxy ? "代理已更新" : "代理已添加").then((saved) => { if (saved) { setEditingProxy(null); setProxyForm(emptyProxy); } });
              }}>
                <h4>{editingProxy ? "编辑代理" : "添加代理"}</h4>
                <div className="form-grid two">
                  <label><span>名称</span><input required value={proxyForm.name} onChange={(event) => setProxyForm({ ...proxyForm, name: event.target.value })} placeholder="例如：家中旁路由" /></label>
                  <label><span>HTTP 代理</span><input value={proxyForm.httpUrl} onChange={(event) => setProxyForm({ ...proxyForm, httpUrl: event.target.value })} placeholder={editingProxy ? "留空保持已保存的 HTTP 地址" : "http://192.168.1.2:7890"} /></label>
                  <label><span>HTTPS 代理</span><input value={proxyForm.httpsUrl} onChange={(event) => setProxyForm({ ...proxyForm, httpsUrl: event.target.value })} placeholder={editingProxy ? "留空保持已保存的 HTTPS 地址" : "http://192.168.1.2:7890"} /></label>
                  <label><span>SOCKS5 代理</span><input value={proxyForm.socks5Url} onChange={(event) => setProxyForm({ ...proxyForm, socks5Url: event.target.value })} placeholder={editingProxy ? "留空保持已保存的 SOCKS5 地址" : "socks5://192.168.1.2:1080"} /></label>
                  <label className="span-two"><span>NO_PROXY</span><input value={proxyForm.noProxy} onChange={(event) => setProxyForm({ ...proxyForm, noProxy: event.target.value })} /></label>
                </div>
                <div className="proxy-help">三个地址可以同时填写；HTTP 请求优先使用 HTTP，HTTPS 请求优先使用 HTTPS，SOCKS5 可作为本应用请求的回退。所有设置只保存在本应用数据中。</div>
                <div className="form-actions"><button type="button" className="ghost-button" onClick={() => { setEditingProxy(null); setProxyForm(emptyProxy); }}>清空</button><button className="primary-button" disabled={busy === "save-proxy" || (!editingProxy && !proxyForm.httpUrl && !proxyForm.httpsUrl && !proxyForm.socks5Url)}><Network size={16} /> {editingProxy ? "保存修改" : "添加代理"}</button></div>
              </form>
            </div>
          )}

          {tab === "permissions" && (
            <div className="settings-section compact-settings">
              <div className="section-heading"><h3>会话默认权限</h3><p>默认审批用于新会话；联网默认值保存时会同步到已有会话，顶部开关仍可单独覆盖。</p></div>
              <div className="setting-card">
                <div><ShieldCheck size={20} /><span><strong>新会话默认值</strong><small>每个聊天会独立保存自己的选择，仍然保留 workspace-write 沙箱。</small></span></div>
                <select value={bootstrap.settings.approvalPolicy} onChange={(event) => void perform("approval-policy", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ approvalPolicy: event.target.value }) }), event.target.value === "never" ? "新会话将默认自动审批" : "新会话将默认逐次确认")}>
                  <option value="on-request">需要时询问我</option>
                  <option value="never">自动审批（推荐给私人 NAS）</option>
                </select>
              </div>
              <div className="setting-card">
                <div><Network size={20} /><span><strong>默认允许命令联网</strong><small>同步到所有已有聊天；只影响 Codex 命令，不修改 NAS 系统网络设置。</small></span></div>
                <select value={bootstrap.settings.networkAccess ? "allow" : "deny"} disabled={busy === "network-access-default"} onChange={(event) => void perform("network-access-default", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ networkAccess: event.target.value === "allow", applyToExistingThreads: true }) }), event.target.value === "allow" ? "所有会话已允许联网" : "所有会话已关闭命令联网")}>
                  <option value="allow">允许联网（当前默认）</option>
                  <option value="deny">禁止联网</option>
                </select>
              </div>
              <div className="settings-warning">自动审批会减少弹窗，但 Codex 仍可能修改项目文件。会话顶部的设置优先于这里的默认值，切换后只影响当前聊天。</div>
              <div className="settings-warning">允许联网会让 Git、curl、依赖安装和浏览器抓取直接访问网络或应用代理。请只在可信项目中使用；单个聊天仍可在顶部临时关闭。</div>
            </div>
          )}

          {tab === "personalization" && <PersonalizationSettings settings={bootstrap.settings} onChanged={onChanged} />}

          {tab === "notifications" && <NotificationSettings />}

          {tab === "appearance" && (
            <div className="settings-section compact-settings">
              <div className="section-heading"><h3>主题与背景</h3><p>主题和背景保存在这台飞牛设备上，电脑和手机打开时保持一致。</p></div>
              <div className="theme-grid">
                {(["system", "light", "dark", "ink"] as const).map((theme) => <button key={theme} className={bootstrap.settings.theme === theme ? "active" : ""} onClick={() => void perform(`theme-${theme}`, () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ theme }) }), "主题已更新")}><span className={`theme-preview ${theme}`} /><strong>{{ system: "跟随系统", light: "明亮", dark: "深色", ink: "墨色" }[theme]}</strong></button>)}
              </div>
              <div className="setting-card background-card">
                <div><ImageIcon size={20} /><span><strong>自定义背景图片</strong><small>支持 PNG、JPEG、WebP，最大 8 MB。</small></span></div>
                <div className="setting-actions"><label className="secondary-button"><Upload size={15} /> {bootstrap.appearance.hasBackground ? "更换图片" : "上传图片"}<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadBackground(event.target.files?.[0])} /></label>{bootstrap.appearance.hasBackground && <button className="danger-button compact" onClick={() => void perform("delete-background", () => api("/api/appearance/background", { method: "DELETE" }), "背景图片已删除")}><Trash2 size={14} /> 删除</button>}</div>
              </div>
              {bootstrap.appearance.hasBackground && <>
                <div className="background-preview" style={{
                  backgroundImage: `url(/api/appearance/background?v=${bootstrap.appearance.updatedAt ?? 0})`,
                  backgroundPosition: bootstrap.settings.backgroundPosition,
                  backgroundSize: bootstrap.settings.backgroundFit === "stretch" ? "100% 100%" : bootstrap.settings.backgroundFit === "tile" ? "auto" : bootstrap.settings.backgroundFit,
                  backgroundRepeat: bootstrap.settings.backgroundFit === "tile" ? "repeat" : "no-repeat",
                }}><span>当前背景预览</span></div>
                <label className="toggle-row"><span>显示背景图片</span><input type="checkbox" checked={bootstrap.settings.backgroundEnabled} onChange={(event) => void perform("background-enabled", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ backgroundEnabled: event.target.checked }) }), "背景显示设置已更新")} /></label>
                <div className="background-options">
                  <label><span>图片适配</span><select value={bootstrap.settings.backgroundFit} onChange={(event) => void perform("background-fit", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ backgroundFit: event.target.value }) }), "背景适配已更新")}><option value="cover">填满屏幕（裁切）</option><option value="contain">完整显示（留白）</option><option value="stretch">拉伸到屏幕</option><option value="tile">原图平铺</option></select></label>
                  <label><span>图片位置</span><select value={bootstrap.settings.backgroundPosition} onChange={(event) => void perform("background-position", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ backgroundPosition: event.target.value }) }), "背景位置已更新")}><option value="center">居中</option><option value="top">顶部</option><option value="bottom">底部</option></select></label>
                </div>
                <label className="range-row"><span>背景强度 <em>{Math.round(bootstrap.settings.backgroundOpacity * 100)}%</em></span><input type="range" min="0.05" max="0.85" step="0.05" value={bootstrap.settings.backgroundOpacity} onChange={(event) => void perform("background-opacity", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ backgroundOpacity: Number(event.target.value) }) }), "背景强度已更新")} /></label>
                <label className="range-row"><span>背景模糊 <em>{bootstrap.settings.backgroundBlur}px</em></span><input type="range" min="0" max="16" step="1" value={bootstrap.settings.backgroundBlur} onChange={(event) => void perform("background-blur", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ backgroundBlur: Number(event.target.value) }) }), "背景模糊已更新")} /></label>
                <label className="range-row"><span>内容面板不透明度 <em>{Math.round(bootstrap.settings.backgroundPanelOpacity * 100)}%</em></span><input type="range" min="0.35" max="0.95" step="0.05" value={bootstrap.settings.backgroundPanelOpacity} onChange={(event) => void perform("background-panel", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ backgroundPanelOpacity: Number(event.target.value) }) }), "内容面板透明度已更新")} /></label>
              </>}
            </div>
          )}

          {tab === "updates" && (
            <div className="settings-section compact-settings">
              <div className="section-heading"><h3>Codex 官方核心</h3><p>工作台界面与 Codex 核心分开更新；这里可以安全更新官方 Linux x64 核心。</p></div>
              <div className="update-card"><div className="update-mark"><Download size={22} /></div><div><span>当前版本</span><strong>{updateInfo.currentVersion}</strong><small>{updateInfo.source === "updated" ? `已在线更新 · 内置回退版本 ${updateInfo.bundledVersion}` : "使用安装包内置版本"}</small></div></div>
              {updateInfo.latestVersion && <div className={`update-result ${updateInfo.updateAvailable ? "available" : "current"}`}><strong>{updateInfo.updateAvailable ? `发现新版本 ${updateInfo.latestVersion}` : "已经是最新版本"}</strong><span>下载后会校验官方 npm 包 SHA-512 和 Linux ELF，启动失败会自动回退。</span></div>}
              <div className="setting-actions"><button className="secondary-button" disabled={busy === "check-update"} onClick={() => void checkCodexUpdate()}><RefreshCw size={15} className={busy === "check-update" ? "spin" : ""} /> 检查更新</button><button className="primary-button" disabled={!updateInfo.canUpdate || !updateInfo.updateAvailable || busy === "install-update"} onClick={() => { if (window.confirm(`更新 Codex 到 ${updateInfo.latestVersion}？更新期间服务会短暂重启。`)) void perform("install-update", () => api("/api/codex/update", { method: "POST", body: "{}" }), "Codex 已更新并重新启动"); }}><Download size={15} /> {busy === "install-update" ? "更新中…" : "立即更新"}</button></div>
              {!updateInfo.canUpdate && <div className="settings-warning">在线安装仅在飞牛 Linux x86_64 环境可用；Windows 开发预览不会修改本机 Codex。</div>}
            </div>
          )}

          {tab === "account" && (
            <div className="settings-section account-section">
              <div className="account-profiles-heading">
                <div><h3>已保存的账户</h3><p>每个账户使用独立的 Codex 凭据、会话和插件目录；切换时 Codex 服务会短暂重启。</p></div>
                <button className="secondary-button compact" disabled={Boolean(busy)} onClick={addAccount}><Plus size={14} /> 添加账户</button>
              </div>
              <div className="account-profiles">
                {bootstrap.accounts.map((profile) => {
                  const authenticated = profile.active ? Boolean(bootstrap.account?.account) : profile.authenticated;
                  return <article className={`account-profile ${profile.active ? "active" : ""}`} key={profile.id}>
                    <span className="account-profile-mark">{(authenticated ? profile.email?.slice(0, 1) : null)?.toUpperCase() || profile.label.slice(0, 1).toUpperCase()}</span>
                    <span><strong>{profile.label}</strong><small>{authenticated ? profile.email || profile.accountType : "尚未登录"}</small><em>{authenticated ? planName(profile.planType) : "等待连接"}</em></span>
                    <span className="account-profile-actions">
                      {profile.active
                        ? <i><CheckCircle2 size={13} /> 当前</i>
                        : <button className="mini-button" disabled={Boolean(busy)} onClick={() => switchAccount(profile.id)}>{busy === `account-switch:${profile.id}` ? "切换中…" : "切换"}</button>}
                      {profile.homeKey !== "legacy" && <button className="icon-button small danger" title="删除账户" disabled={Boolean(busy)} onClick={() => deleteAccount(profile)}><Trash2 size={13} /></button>}
                    </span>
                  </article>;
                })}
              </div>
              <div className="account-card">
                <div className="provider-avatar openai">O</div>
                <div><h3>{bootstrap.account?.account?.email || bootstrap.account?.activeProfile?.label || "官方 OpenAI / ChatGPT（可选）"}</h3><p>{bootstrap.account?.account ? `${bootstrap.account.account.type} · ${planName(bootstrap.account.account.planType || bootstrap.account?.rateLimits?.rateLimits.planType)}` : "当前账户槽位尚未登录；第三方供应商无需在这里连接。"}</p></div>
              </div>
              {bootstrap.account?.rateLimits && <div className="account-usage">
                <header><span><Gauge size={16} /><strong>Codex 用量（来自官方 app-server）</strong></span><button className="mini-button" disabled={busy === "usage-refresh"} onClick={() => void perform("usage-refresh", () => api("/api/account?refresh=1"), "账户用量已刷新")}>{busy === "usage-refresh" ? "刷新中…" : "刷新"}</button></header>
                {[usageSnapshot(bootstrap)?.primary, usageSnapshot(bootstrap)?.secondary].map((window, index) => {
                  const snapshot = usageSnapshot(bootstrap);
                  if (!window || !snapshot) return null;
                  const state = usageState(snapshot, window);
                  return <div className="usage-window" key={index}>
                    <div><strong>{windowName(window, index === 0 ? "主额度" : "次额度")}</strong><span>{state.label}</span></div>
                    <div className="usage-track"><i style={{ width: `${state.usedPercent ?? 0}%` }} /></div>
                    <small><Clock3 size={12} /> {resetTime(window.resetsAt)} 重置{state.usedPercent === null ? " · 官方未返回可用百分比" : ""}</small>
                  </div>;
                })}
                {!usageSnapshot(bootstrap) && <div className="settings-warning">官方本次没有返回 `limitId=codex` 的额度桶，因此无法可靠计算 Codex 剩余用量。已停止使用其他 30 天额度桶冒充 Codex 用量。</div>}
                {exhaustionReason(bootstrap) && <div className="settings-error">官方返回额度限制状态：{exhaustionReason(bootstrap)}</div>}
                <details className="usage-diagnostics">
                  <summary>查看官方返回的额度桶</summary>
                  {rateLimitEntries(bootstrap).length === 0 && <p>没有返回任何额度桶。</p>}
                  {rateLimitEntries(bootstrap).map(([limitId, snapshot]) => <div key={limitId}>
                    <strong>{snapshot.limitName || limitId}</strong>
                    <span>limitId: {snapshot.limitId || limitId}</span>
                    {[snapshot.primary, snapshot.secondary].map((window, index) => window && <span key={index}>{windowName(window, index === 0 ? "主额度" : "次额度")}：已用 {Number.isFinite(Number(window.usedPercent)) ? `${window.usedPercent}%` : "未知"}，{resetTime(window.resetsAt)} 重置</span>)}
                    {snapshot.rateLimitReachedType && <span>限制状态：{snapshot.rateLimitReachedType}</span>}
                  </div>)}
                </details>
              </div>}
              {bootstrap.account?.rateLimitsError && <div className="settings-warning">套餐已识别，但本次用量刷新失败：{bootstrap.account.rateLimitsError}</div>}
              {bootstrap.account?.account?.type === "apiKey" && <div className="account-note">当前使用 API Key 按量计费，官方不会返回 ChatGPT 套餐剩余百分比或套餐重置时间。</div>}
              {!bootstrap.account?.account && <>
                <div className="account-note">如果设备码返回 403，通常是当前 NAS 网络被官方接口拒绝。请配置可用的应用默认代理，或者直接使用 OpenAI API Key。</div>
                <button className="secondary-button" onClick={async () => {
                  setBusy("device-login"); setError("");
                  try {
                    const result = await api<{ loginId: string; verificationUrl: string; userCode: string }>("/api/account/login", { method: "POST", body: JSON.stringify({ type: "device" }) });
                    setDeviceLogin({ ...result, status: "pending" });
                  } catch (reason) { setError(reason instanceof Error ? reason.message : "登录启动失败"); } finally { setBusy(null); }
                }}>{busy === "device-login" ? "正在生成设备码…" : "使用 ChatGPT 设备码登录"}</button>
                {deviceLogin && <div className={`device-code ${deviceLogin.status}`}><span>在另一窗口打开</span><a href={deviceLogin.verificationUrl} target="_blank" rel="noreferrer">{deviceLogin.verificationUrl}</a><strong>{deviceLogin.userCode}</strong><small>{deviceLogin.status === "pending" ? "正在等待网页授权…" : deviceLogin.status === "browserCompleted" ? "网页授权完成，正在确认 NAS 凭据…" : deviceLogin.error}</small>{deviceLogin.status === "error" && <button className="mini-button" onClick={() => setDeviceLogin(null)}>重新生成设备码</button>}</div>}
                <div className="divider"><span>或者</span></div>
                <form className="inline-key-form" onSubmit={(event) => { event.preventDefault(); perform("api-login", () => api("/api/account/login", { method: "POST", body: JSON.stringify({ type: "apiKey", apiKey }) }), "API Key 已连接").then((saved) => { if (saved) setApiKey(""); }); }}><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="OpenAI API Key" /><button className="secondary-button" disabled={!apiKey || busy === "api-login"}>连接</button></form>
              </>}
              {bootstrap.account?.account && <button className="danger-button" onClick={() => perform("logout", () => api("/api/account/logout", { method: "POST", body: "{}" }), "当前 OpenAI 账户已退出；其他已保存账户不受影响")}>退出当前账户</button>}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
