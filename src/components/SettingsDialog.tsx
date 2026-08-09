import { CheckCircle2, CloudCog, Download, Image as ImageIcon, KeyRound, LoaderCircle, Network, Palette, Pencil, PlugZap, RefreshCw, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Bootstrap, CodexUpdateState, ProviderProfile, ProxyProfile } from "../types";
import { ModelCombobox } from "./ModelCombobox";
import { Modal } from "./Modal";

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

export function SettingsDialog({ open, bootstrap, onClose, onChanged }: Props) {
  const [tab, setTab] = useState<"providers" | "proxies" | "permissions" | "appearance" | "updates" | "account">("providers");
  const [providerForm, setProviderForm] = useState(emptyProvider);
  const [proxyForm, setProxyForm] = useState(emptyProxy);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editingProxy, setEditingProxy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [deviceLogin, setDeviceLogin] = useState<{ verificationUrl: string; userCode: string } | null>(null);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [updateInfo, setUpdateInfo] = useState<CodexUpdateState>(bootstrap.codex);

  useEffect(() => {
    if (!open) {
      setNotice("");
      setError("");
    }
  }, [open]);

  useEffect(() => { setUpdateInfo(bootstrap.codex); }, [bootstrap.codex]);

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

  function editProvider(provider: ProviderProfile) {
    setEditingProvider(provider.id);
    setProviderForm({
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "",
      proxyMode: provider.proxyMode,
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
              <label className="default-proxy"><span>应用默认代理</span><select value={bootstrap.settings.defaultProxyId ?? ""} onChange={(event) => perform("default-proxy", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ defaultProxyId: event.target.value || null }) }), "应用代理已更新，Codex 服务正在重载")}><option value="">直连</option>{bootstrap.proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name}</option>)}</select></label>
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
              <div className="section-heading"><h3>命令审批</h3><p>控制 Codex 执行命令或修改文件时是否需要你逐次确认。</p></div>
              <div className="setting-card">
                <div><ShieldCheck size={20} /><span><strong>审批方式</strong><small>仍然保留 workspace-write 沙箱，只自动放行工作区内的正常操作。</small></span></div>
                <select value={bootstrap.settings.approvalPolicy} onChange={(event) => void perform("approval-policy", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ approvalPolicy: event.target.value }) }), event.target.value === "never" ? "已开启自动审批" : "已恢复逐次确认")}>
                  <option value="on-request">需要时询问我</option>
                  <option value="never">自动审批（推荐给私人 NAS）</option>
                </select>
              </div>
              <div className="settings-warning">自动审批会减少弹窗，但 Codex 仍可能修改项目文件。建议只对你信任的私人项目开启，并通过“项目文件和改动”面板检查结果。</div>
            </div>
          )}

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
              {bootstrap.appearance.hasBackground && <><div className="background-preview" style={{ backgroundImage: `url(/api/appearance/background?v=${bootstrap.appearance.updatedAt ?? 0})` }}><span>当前背景预览</span></div><label className="toggle-row"><span>显示背景图片</span><input type="checkbox" checked={bootstrap.settings.backgroundEnabled} onChange={(event) => void perform("background-enabled", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ backgroundEnabled: event.target.checked }) }), "背景显示设置已更新")} /></label><label className="range-row"><span>背景强度 <em>{Math.round(bootstrap.settings.backgroundOpacity * 100)}%</em></span><input type="range" min="0.05" max="0.85" step="0.05" value={bootstrap.settings.backgroundOpacity} onChange={(event) => void perform("background-opacity", () => api("/api/settings", { method: "PATCH", body: JSON.stringify({ backgroundOpacity: Number(event.target.value) }) }), "背景强度已更新")} /></label></>}
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
              <div className="account-card">
                <div className="provider-avatar openai">O</div>
                <div><h3>{bootstrap.account?.account?.email || "官方 OpenAI / ChatGPT（可选）"}</h3><p>{bootstrap.account?.account ? `${bootstrap.account.account.type} · ${bootstrap.account.account.planType || "账户已连接"}` : "只有使用官方模型时才需要；第三方供应商无需在这里登录。"}</p></div>
              </div>
              {!bootstrap.account?.account && <>
                <div className="account-note">如果设备码返回 403，通常是当前 NAS 网络被官方接口拒绝。请配置可用的应用默认代理，或者直接使用 OpenAI API Key。</div>
                <button className="secondary-button" onClick={async () => {
                  setBusy("device-login"); setError("");
                  try { setDeviceLogin(await api<{ verificationUrl: string; userCode: string }>("/api/account/login", { method: "POST", body: JSON.stringify({ type: "device" }) })); } catch (reason) { setError(reason instanceof Error ? reason.message : "登录启动失败"); } finally { setBusy(null); }
                }}>{busy === "device-login" ? "正在生成设备码…" : "使用 ChatGPT 设备码登录"}</button>
                {deviceLogin && <div className="device-code"><span>在另一窗口打开</span><a href={deviceLogin.verificationUrl} target="_blank" rel="noreferrer">{deviceLogin.verificationUrl}</a><strong>{deviceLogin.userCode}</strong></div>}
                <div className="divider"><span>或者</span></div>
                <form className="inline-key-form" onSubmit={(event) => { event.preventDefault(); perform("api-login", () => api("/api/account/login", { method: "POST", body: JSON.stringify({ type: "apiKey", apiKey }) }), "API Key 已连接").then((saved) => { if (saved) setApiKey(""); }); }}><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="OpenAI API Key" /><button className="secondary-button" disabled={!apiKey || busy === "api-login"}>连接</button></form>
              </>}
              {bootstrap.account?.account && <button className="danger-button" onClick={() => perform("logout", () => api("/api/account/logout", { method: "POST", body: "{}" }), "OpenAI 账户已退出")}>退出 OpenAI 账户</button>}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
