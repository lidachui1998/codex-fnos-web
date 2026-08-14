import { Bot, Boxes, Check, FileUp, LoaderCircle, PackageCheck, RefreshCw, Search, Store, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { PluginSummary, PluginsResult } from "../types";
import { Modal } from "./Modal";

function pluginName(plugin: PluginSummary) {
  return plugin.interface?.displayName || plugin.name;
}

function pluginDescription(plugin: PluginSummary) {
  return plugin.interface?.shortDescription || plugin.interface?.longDescription || "暂无说明";
}

type PluginTab = "market" | "installed";

export function PluginsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<PluginsResult>({ data: [], errors: [], featuredPluginIds: [] });
  const [tab, setTab] = useState<PluginTab>("market");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [authApps, setAuthApps] = useState<Array<{ id?: string; name?: string; installUrl?: string | null }>>([]);

  async function load(reload = false) {
    setLoading(true); setError("");
    try {
      setResult(await api<PluginsResult>(`/api/plugins${reload ? "?reload=1" : ""}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "插件列表读取失败");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (open) void load();
    else { setError(""); setNotice(""); setAuthApps([]); setQuery(""); setTab("market"); }
  }, [open]);

  const installedCount = result.data.filter((plugin) => plugin.installed).length;
  const marketCount = result.data.length - installedCount;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return result.data.filter((plugin) => {
      if (tab === "installed" ? !plugin.installed : plugin.installed) return false;
      return !needle || `${pluginName(plugin)} ${plugin.name} ${pluginDescription(plugin)} ${plugin.keywords?.join(" ") || ""}`.toLowerCase().includes(needle);
    });
  }, [query, result.data, tab]);

  async function install(plugin: PluginSummary) {
    setBusyId(plugin.id); setError(""); setNotice("");
    try {
      const response = await api<{ appsNeedingAuth?: Array<{ id?: string; name?: string; installUrl?: string | null }> }>("/api/plugins/install", {
        method: "POST",
        body: JSON.stringify({
          pluginName: plugin.name,
          marketplaceName: plugin.marketplaceName,
          marketplacePath: plugin.marketplacePath,
        }),
      });
      const pendingApps = response.appsNeedingAuth ?? [];
      const authNames = pendingApps.map((item) => item.name).filter(Boolean);
      setAuthApps(pendingApps);
      setNotice(authNames.length > 0
        ? `已安装 ${pluginName(plugin)}。其中 ${authNames.join("、")} 还需要完成账号授权。`
        : `已安装 ${pluginName(plugin)}；已移入“已安装”管理。`);
      await load();
      setTab("installed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "插件安装失败");
    } finally { setBusyId(""); }
  }

  async function importPlugin(file?: File) {
    if (!file) return;
    setImporting(true); setError(""); setNotice("");
    try {
      const response = await api<{ imported: { name: string }; installError?: string | null }>(`/api/plugins/import?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      });
      await load(true);
      if (response.installError) {
        setTab("market");
        setNotice(`已把 ${response.imported.name} 导入全局插件市场，但自动安装未完成：${response.installError}`);
      } else {
        setTab("installed");
        setNotice(`已导入并安装全局插件：${response.imported.name}`);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "插件导入失败"); }
    finally { setImporting(false); }
  }

  async function uninstall(plugin: PluginSummary) {
    if (!window.confirm(`卸载插件“${pluginName(plugin)}”？`)) return;
    setBusyId(plugin.id); setError(""); setNotice("");
    try {
      await api(`/api/plugins/${encodeURIComponent(plugin.remotePluginId || plugin.id)}`, { method: "DELETE" });
      setNotice(`已卸载 ${pluginName(plugin)}；它不再出现在已安装列表中。`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "插件卸载失败");
    } finally { setBusyId(""); }
  }

  const marketplaceErrors = result.errors.map((item) => typeof item === "string" ? item : item.message || item.marketplacePath || "插件市场读取失败");
  return <Modal open={open} title="插件中心" subtitle="市场用于发现和导入，已安装用于启用后的插件管理；两边状态互不混淆。" onClose={onClose} wide>
    <div className="plugin-tabs" role="tablist" aria-label="插件管理">
      <button className={tab === "market" ? "active" : ""} role="tab" aria-selected={tab === "market"} onClick={() => setTab("market")}><Store size={16} /><span><strong>插件市场</strong><small>发现与导入</small></span><em>{marketCount}</em></button>
      <button className={tab === "installed" ? "active" : ""} role="tab" aria-selected={tab === "installed"} onClick={() => setTab("installed")}><PackageCheck size={16} /><span><strong>已安装</strong><small>管理与卸载</small></span><em>{installedCount}</em></button>
    </div>
    <div className="plugins-toolbar">
      <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "market" ? "搜索插件市场" : "搜索已安装插件"} /></label>
      {tab === "market" && <label className={`secondary-button compact file-button ${importing ? "disabled" : ""}`}><FileUp size={14} /> {importing ? "导入中…" : "导入 ZIP"}<input className="sr-only" type="file" accept=".zip,application/zip" disabled={importing} onChange={(event) => { const input = event.currentTarget; void importPlugin(input.files?.[0]).finally(() => { input.value = ""; }); }} /></label>}
      <button className="secondary-button compact" disabled={loading} onClick={() => void load(true)}><RefreshCw size={14} className={loading ? "spin" : ""} /> 刷新</button>
    </div>
    {tab === "market" && <div className="extension-agent-note plugin-note"><Bot size={17} /><span><strong>Codex 可以创建全局插件</strong><small>在聊天里说明插件用途和工作流，确认后 Codex 会创建标准插件包并放入当前账户的个人市场；之后在这里安装。</small></span></div>}
    {tab === "market" && <div className="settings-warning">ZIP 中必须包含 `.codex-plugin/plugin.json`。只导入你信任的插件；连接器仍可能需要单独完成账号授权。</div>}
    {error && <div className="settings-error">{error}</div>}
    {notice && <div className="settings-success">{notice}</div>}
    {authApps.length > 0 && <div className="plugin-auth-links"><strong>完成连接器授权</strong>{authApps.map((app) => app.installUrl
      ? <a key={app.id || app.name} href={app.installUrl} target="_blank" rel="noreferrer">打开 {app.name || "连接器"} 授权页面</a>
      : <span key={app.id || app.name}>{app.name || "连接器"} 暂未返回授权链接，请在 ChatGPT 的连接器设置中完成授权。</span>)}</div>}
    {tab === "market" && marketplaceErrors.length > 0 && <div className="settings-warning">{marketplaceErrors.join("；")}</div>}
    <div className="plugins-list">
      {visible.map((plugin) => <article className={`plugin-card ${plugin.installed ? "installed" : ""}`} key={`${plugin.marketplaceName}:${plugin.id}`}>
        <span className="plugin-icon"><Boxes size={19} /></span>
        <span className="plugin-copy"><strong>{pluginName(plugin)}</strong><small>{pluginDescription(plugin)}</small><em>{plugin.interface?.developerName || plugin.marketplaceName || "Codex 插件市场"}{plugin.version ? ` · v${plugin.version}` : ""}</em></span>
        <span className="plugin-action">
          {tab === "installed"
            ? <><span className="installed-label"><Check size={12} /> 已安装</span><button className="icon-button small danger" disabled={busyId === plugin.id} title="卸载插件" onClick={() => void uninstall(plugin)}>{busyId === plugin.id ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}</button></>
            : <button className="primary-button compact" disabled={Boolean(busyId) || plugin.installPolicy === "NOT_AVAILABLE" || plugin.availability === "DISABLED_BY_ADMIN"} title={plugin.disabledReason || undefined} onClick={() => void install(plugin)}>{busyId === plugin.id ? <LoaderCircle size={14} className="spin" /> : null}{plugin.installPolicy === "NOT_AVAILABLE" ? "不可安装" : "安装"}</button>}
        </span>
      </article>)}
      {!loading && visible.length === 0 && <div className="plugins-empty">{error ? "当前 Codex 核心还不能提供插件列表，请先在设置中升级核心。" : tab === "installed" ? "还没有已安装插件。去插件市场安装或导入一个吧。" : "没有找到可安装的插件。"}</div>}
    </div>
    <div className="plugins-footer"><span>市场 {marketCount} 个 · 已安装 {installedCount} 个</span><button className="primary-button" onClick={onClose}>完成</button></div>
  </Modal>;
}
