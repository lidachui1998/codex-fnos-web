import { RefreshCw, Power, PlugZap } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { BridgeState } from "../types";

type Runtime = { bridge: BridgeState; activeTurns: number; recoveryAttempts: number; nextRetryAt: number | null };
type McpServer = { name: string; authStatus: string; tools: string[]; resourceCount: number; templateCount: number };
const states: Record<BridgeState["status"], string> = { ready: "运行正常", starting: "启动中", initializing: "初始化中", stopping: "停止中", stopped: "已停止", error: "服务异常" };

export function RuntimeSettings({ onChanged, threadId }: { onChanged: () => Promise<void>; threadId?: string }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const refresh = async () => {
      try {
        const result = await api<Runtime>("/api/bridge/status");
        if (!cancelled) setRuntime(result);
      } catch (reason) { if (!cancelled) setError(String(reason)); }
      if (!cancelled) timer = window.setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  async function perform(action: "restart" | "inspect" | "reload") {
    setBusy(action); setError(""); setNotice("");
    try {
      if (action === "restart") {
        let result: Runtime;
        try { result = await api<Runtime>("/api/bridge/restart", { method: "POST", body: "{}" }); }
        catch (reason) {
          if (!(reason instanceof ApiError) || reason.status !== 409) throw reason;
          if (!window.confirm(`${reason.message}。仍要重启 Codex 后台服务吗？`)) return;
          result = await api<Runtime>("/api/bridge/restart", { method: "POST", body: JSON.stringify({ force: true }) });
        }
        setRuntime(result); setServers(null);
        setNotice("Codex 后台服务已重新就绪，会话记录和设置已保留。");
        await onChanged();
      } else if (action === "reload") {
        const result = await api<{ message: string }>("/api/mcp/reload", { method: "POST", body: "{}" });
        setServers(null); setNotice(result.message);
      } else {
        const result = await api<{ data: McpServer[]; truncated: boolean }>(`/api/mcp/status${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`);
        setServers(result.data);
        if (result.truncated) setNotice("服务较多，当前仅显示前 2000 项。");
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(/method not found|unknown method/i.test(message) ? "当前 Codex 核心不支持该 MCP 管理接口，请在 Codex 更新中升级核心。" : message);
    } finally { setBusy(""); }
  }

  return <div className="settings-section compact-settings runtime-settings">
    <div className="section-heading"><h3>Codex 后台服务</h3><p>NAS 重启后无法回复、核心进程异常时，可以在这里恢复。</p></div>
    <div className="runtime-card">
      <strong>{runtime ? states[runtime.bridge.status] : "读取状态中…"}</strong>
      <p>进程 {runtime?.bridge.pid ?? "未启动"} · {runtime?.activeTurns ?? 0} 个执行中的任务</p>
      {runtime?.bridge.error && <div className="form-error">{runtime.bridge.error}</div>}
      {runtime?.nextRetryAt && <p>正在自动恢复，第 {runtime.recoveryAttempts + 1} 次尝试。</p>}
      <button className="secondary-button" disabled={Boolean(busy) || !runtime || ["starting", "initializing", "stopping"].includes(runtime.bridge.status)} onClick={() => void perform("restart")}><Power size={16} />{busy === "restart" ? "重启中…" : "重启 Codex 后台服务"}</button>
      <small>如有正在运行的对话或子代理，会先提醒你确认中断。</small>
    </div>
    <div className="section-heading"><h3>MCP 服务</h3><p>检查{threadId ? "当前会话" : "当前账户"}实际加载的工具与资源。资源接口失败不一定意味着搜索工具不可用。</p></div>
    <div className="setting-actions">
      <button className="secondary-button" disabled={Boolean(busy) || runtime?.bridge.status !== "ready"} onClick={() => void perform("inspect")}><PlugZap size={15} />{busy === "inspect" ? "检查中…" : "检查 MCP"}</button>
      <button className="secondary-button" disabled={Boolean(busy) || runtime?.bridge.status !== "ready"} onClick={() => void perform("reload")}><RefreshCw size={15} />{busy === "reload" ? "重载中…" : "重载 MCP"}</button>
    </div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <div className="success-banner" role="status">{notice}</div>}
    {servers?.length === 0 && <div className="empty-inline">没有发现 MCP 服务。检查当前账户配置后点击重载。</div>}
    {servers?.map((server) => <div className="runtime-card" key={server.name}>
      <strong>{server.name}</strong><p>{server.tools.length} 个工具 · {server.resourceCount} 项资源 · {server.templateCount} 个资源模板</p>
      {server.authStatus === "notLoggedIn" && <div className="form-error">尚未登录该 MCP 服务</div>}
      {!server.tools.length && !server.resourceCount && !server.templateCount && <p>尚未发现可用能力，请检查会话中的具体错误、服务配置与网络，再重载 MCP。</p>}
      {server.tools.length > 0 && !server.resourceCount && !server.templateCount && <p>该服务当前只暴露工具；请调用下方工具，不要猜测资源 URI。</p>}
      <details><summary>查看工具名称</summary><pre>{server.tools.join("\n") || "无工具"}</pre></details>
    </div>)}
  </div>;
}
