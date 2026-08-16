import { AlertTriangle, Bot, CheckCircle2, ChevronRight, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { runningAgentStatuses, threadAgentStatus, type AgentViewState } from "../subagents";
import type { Thread, ThreadItem } from "../types";
import { Timeline } from "./Timeline";

type Props = {
  rootThreadId: string;
  agent: AgentViewState;
  agents: AgentViewState[];
  projectPath: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenSubagent: (agent: AgentViewState) => void;
};

function displayName(agent: AgentViewState, thread?: Thread | null) {
  return thread?.agentNickname?.trim()
    || agent.name?.trim()
    || agent.role?.trim()
    || agent.path?.split("/").filter(Boolean).at(-1)
    || `子代理 ${agent.id.slice(-8)}`;
}

function panelStatus(agent: AgentViewState, thread?: Thread | null) {
  return thread ? threadAgentStatus(thread) : agent.status;
}

function statusLabel(status: string) {
  return ({
    pendingInit: "准备中",
    running: "运行中",
    inProgress: "运行中",
    waitingApproval: "等待批准",
    waitingInput: "等待输入",
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

export function SubagentPanel({ rootThreadId, agent, agents, projectPath, onClose, onOpenFile, onOpenSubagent }: Props) {
  const [selectedAgentId, setSelectedAgentId] = useState(agent.id);
  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const visibleAgents = useMemo(() => agents.some((item) => item.id === agent.id) ? agents : [agent, ...agents], [agent, agents]);
  const selectedAgent = visibleAgents.find((item) => item.id === selectedAgentId) ?? agent;
  const items = useMemo(() => readOnlyTranscript(thread), [thread]);
  const status = panelStatus(selectedAgent, thread);
  const running = runningAgentStatuses.has(status);
  const runningCount = visibleAgents.filter((item) => runningAgentStatuses.has(item.status)).length;
  const failedCount = visibleAgents.filter((item) => ["failed", "errored", "interrupted", "notFound"].includes(item.status)).length;
  const activeTurnId = [...(thread?.turns ?? [])].reverse().find((turn) => turn.status === "inProgress")?.id ?? null;

  useEffect(() => setSelectedAgentId(agent.id), [agent.id]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const controller = new AbortController();

    async function load() {
      try {
        const result = await api<{ thread: Thread }>(`/api/threads/${encodeURIComponent(selectedAgent.id)}`, { cache: "no-store", signal: controller.signal });
        if (cancelled) return;
        setThread(result.thread);
        setError("");
        setLoading(false);
        timer = window.setTimeout(load, runningAgentStatuses.has(threadAgentStatus(result.thread)) ? 1200 : 3500);
      } catch (reason) {
        if (cancelled || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setError(reason instanceof Error ? reason.message : "无法读取子代理会话");
        setLoading(false);
        timer = window.setTimeout(load, 4500);
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
  }, [selectedAgent.id, revision]);

  function selectAgent(next: AgentViewState) {
    setSelectedAgentId(next.id);
    onOpenSubagent(next);
  }

  return (
    <aside className="subagent-panel" aria-label="子代理详情">
      <header>
        <div className={`subagent-panel-mark ${runningCount > 0 ? "running" : failedCount > 0 ? "failed" : "completed"}`}>
          {runningCount > 0 ? <LoaderCircle size={17} /> : failedCount > 0 ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
        </div>
        <span><strong>子代理</strong><small>真实状态 · {runningCount} 个运行或等待 · {visibleAgents.length} 个总计</small></span>
        <div className="subagent-panel-actions"><button className="icon-button small" onClick={() => setRevision((value) => value + 1)} aria-label="刷新子代理详情"><RefreshCw size={15} /></button><button className="icon-button small" onClick={onClose} aria-label="关闭子代理详情"><X size={17} /></button></div>
      </header>
      <nav className="subagent-panel-agents" aria-label="子代理列表">
        {visibleAgents.map((item) => <button type="button" className={item.id === selectedAgent.id ? "active" : ""} key={item.id} onClick={() => selectAgent(item)}><i className={runningAgentStatuses.has(item.status) ? "running" : item.status} /><span><strong>{displayName(item)}</strong><small>{item.role || item.path || item.id}</small></span><em>{statusLabel(item.status)}</em><ChevronRight size={13} /></button>)}
      </nav>
      <div className="subagent-panel-meta"><Bot size={13} /><span title={selectedAgent.id}>{displayName(selectedAgent, thread)} · {selectedAgent.id}</span><small>{thread?.parentThreadId === rootThreadId ? "直接子代理" : thread?.parentThreadId ? "嵌套子代理" : statusLabel(status)}</small></div>
      <div className="subagent-panel-body">
        {loading && <div className="subagent-panel-state loading"><LoaderCircle size={17} />正在读取子代理会话…</div>}
        {error && <div className="subagent-panel-state error"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setRevision((value) => value + 1)}><RefreshCw size={13} />重新读取</button></div>}
        {!loading && !error && items.length === 0 && <div className="subagent-panel-state"><Bot size={18} />这个子代理暂时没有可显示的会话内容。</div>}
        {!loading && !error && items.length > 0 && <Timeline
          items={items}
          turnRunning={running}
          activeTurnId={activeTurnId}
          retryProviders={[]}
          retryProviderId=""
          projectPath={thread?.cwd || projectPath}
          onOpenFile={onOpenFile}
          onResend={() => undefined}
          onRegenerate={() => undefined}
          onEditBranch={() => undefined}
          onOpenSubagent={selectAgent}
          readOnly
        />}
      </div>
    </aside>
  );
}
