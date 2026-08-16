import { AlertTriangle, Bot, CheckCircle2, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Thread, ThreadItem } from "../types";
import { Timeline, type AgentViewState } from "./Timeline";

type Props = {
  agent: AgentViewState;
  projectPath: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenSubagent: (agent: AgentViewState) => void;
};

function displayName(agent: AgentViewState, thread?: Thread | null) {
  return thread?.agentNickname?.trim()
    || agent.path?.split("/").filter(Boolean).at(-1)
    || `子代理 ${agent.id.slice(-8)}`;
}

function panelStatus(agent: AgentViewState, thread?: Thread | null) {
  const threadStatus = typeof thread?.status === "string" ? thread.status : thread?.status?.type;
  if (threadStatus === "active") return "running";
  if (threadStatus === "systemError") return "failed";
  if (["failed", "errored", "interrupted", "notFound"].includes(agent.status)) return agent.status;
  if (threadStatus === "idle" || threadStatus === "notLoaded") return "completed";
  return agent.status;
}

function statusLabel(status: string) {
  return ({
    pendingInit: "准备中",
    running: "运行中",
    inProgress: "运行中",
    completed: "已完成",
    shutdown: "已结束",
    interrupted: "已中断",
    errored: "失败",
    failed: "失败",
    notFound: "未找到",
  } as Record<string, string>)[status] ?? status;
}

function readOnlyTranscript(thread?: Thread | null) {
  return thread?.turns?.flatMap((turn) => {
    const items = (turn.items ?? []).map((item) => ({ ...item, turnId: turn.id }));
    if (turn.status !== "failed") return items;
    const message = typeof turn.error === "string"
      ? turn.error
      : turn.error?.message || "子代理执行失败，但没有返回详细原因。";
    return [...items, { id: `subagent-error:${turn.id}`, turnId: turn.id, type: "turnError", status: "failed", text: message } satisfies ThreadItem];
  }) ?? [];
}

export function SubagentPanel({ agent, projectPath, onClose, onOpenFile, onOpenSubagent }: Props) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const items = useMemo(() => readOnlyTranscript(thread), [thread]);
  const status = panelStatus(agent, thread);
  const running = status === "running" || status === "pendingInit" || status === "inProgress";

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const controller = new AbortController();

    async function load() {
      try {
        const result = await api<{ thread: Thread }>(`/api/threads/${encodeURIComponent(agent.id)}`, { signal: controller.signal });
        if (cancelled) return;
        setThread(result.thread);
        setError("");
        setLoading(false);
        const nextStatus = typeof result.thread.status === "string" ? result.thread.status : result.thread.status?.type;
        if (nextStatus === "active") timer = window.setTimeout(load, 2500);
      } catch (reason) {
        if (cancelled || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setError(reason instanceof Error ? reason.message : "无法读取子代理会话");
        setLoading(false);
      }
    }

    setThread(null);
    setLoading(true);
    setError("");
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [agent.id, revision]);

  return (
    <aside className="subagent-panel" aria-label="子代理详情">
      <header>
        <div className={`subagent-panel-mark ${status}`}>
          {running ? <LoaderCircle size={17} /> : ["failed", "errored", "interrupted", "notFound"].includes(status) ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
        </div>
        <span><strong>{displayName(agent, thread)}</strong><small>{thread?.agentRole ? `${thread.agentRole} · ` : ""}{statusLabel(status)}</small></span>
        <button className="icon-button small" onClick={onClose} aria-label="关闭子代理详情"><X size={17} /></button>
      </header>
      <div className="subagent-panel-meta"><Bot size={13} /><span title={agent.id}>{agent.id}</span>{thread?.parentThreadId && <small>来自当前主会话</small>}</div>
      <div className="subagent-panel-body">
        {loading && <div className="subagent-panel-state loading"><LoaderCircle size={17} />正在读取子代理会话…</div>}
        {error && <div className="subagent-panel-state error"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setRevision((value) => value + 1)}><RefreshCw size={13} />重新读取</button></div>}
        {!loading && !error && items.length === 0 && <div className="subagent-panel-state"><Bot size={18} />这个子代理暂时没有可显示的会话内容。</div>}
        {!loading && !error && items.length > 0 && <Timeline
          items={items}
          turnRunning={running}
          retryProviders={[]}
          retryProviderId=""
          projectPath={thread?.cwd || projectPath}
          onOpenFile={onOpenFile}
          onResend={() => undefined}
          onRegenerate={() => undefined}
          onEditBranch={() => undefined}
          onOpenSubagent={onOpenSubagent}
          readOnly
        />}
      </div>
    </aside>
  );
}
