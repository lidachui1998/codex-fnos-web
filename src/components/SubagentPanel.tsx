import { AlertTriangle, Bot, CheckCircle2, ChevronRight, CornerDownRight, LoaderCircle, RefreshCw, RotateCcw, Send, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { createClientId } from "../client-id";
import { runningAgentStatuses, threadAgentStatus, type AgentViewState } from "../subagents";
import type { PendingServerRequest, SubagentJoinState, Thread, ThreadItem } from "../types";
import { ApprovalCard } from "./ApprovalCard";
import { Timeline } from "./Timeline";
import { UserInputCard } from "./UserInputCard";

type Props = {
  rootThreadId: string;
  agent: AgentViewState;
  agents: AgentViewState[];
  projectPath: string;
  pendingRequests: PendingServerRequest[];
  onRequestResolved: (id: number) => void;
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

export function SubagentPanel({ rootThreadId, agent, agents, projectPath, pendingRequests, onRequestResolved, onClose, onOpenFile, onOpenSubagent }: Props) {
  const [selectedAgentId, setSelectedAgentId] = useState(agent.id);
  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState("");
  const visibleAgents = useMemo(() => agents.some((item) => item.id === agent.id) ? agents : [agent, ...agents], [agent, agents]);
  const selectedAgent = visibleAgents.find((item) => item.id === selectedAgentId) ?? agent;
  const items = useMemo(() => readOnlyTranscript(thread), [thread]);
  const status = panelStatus(selectedAgent, thread);
  const running = runningAgentStatuses.has(status);
  const runningCount = visibleAgents.filter((item) => runningAgentStatuses.has(item.status)).length;
  const failedCount = visibleAgents.filter((item) => ["failed", "errored", "interrupted", "notFound"].includes(item.status)).length;
  const activeTurnId = [...(thread?.turns ?? [])].reverse().find((turn) => turn.status === "inProgress")?.id ?? null;
  const selectedRequests = pendingRequests.filter((request) => request.params?.threadId === selectedAgent.id);
  const waitingForRequest = selectedRequests.length > 0;

  useEffect(() => { setSelectedAgentId(agent.id); setPrompt(""); setActionError(""); }, [agent.id]);

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

  async function queueFollowUp(text: string, projectId: string) {
    await api(`/api/threads/${selectedAgent.id}/outbox`, {
      method: "POST",
      body: JSON.stringify({
        text,
        projectId,
        approvalPolicy: thread?.approvalPolicy,
        networkAccess: thread?.networkAccess,
        skills: [],
        attachments: [],
      }),
    });
  }

  async function sendFollowUp(override?: string) {
    const text = String(override ?? prompt).trim();
    const projectId = thread?.projectId;
    if (!text || !projectId || sending || waitingForRequest) return;
    setSending(true);
    setActionError("");
    try {
      let targetTurnId = activeTurnId;
      let join: SubagentJoinState | null = null;
      if (!targetTurnId && !running) {
        const resumed = await api<{ activeTurnId?: string | null; subagentJoin?: SubagentJoinState | null }>(`/api/threads/${selectedAgent.id}/resume`, {
          method: "POST",
          body: "{}",
        });
        targetTurnId = resumed.activeTurnId ?? null;
        join = resumed.subagentJoin ?? null;
      }
      if (targetTurnId) {
        await api(`/api/threads/${selectedAgent.id}/steer`, {
          method: "POST",
          body: JSON.stringify({
            text,
            clientId: createClientId(),
            projectId,
            expectedTurnId: targetTurnId,
            skills: [],
            attachments: [],
          }),
        });
      } else if (running || join) {
        await queueFollowUp(text, projectId);
      } else {
        await api(`/api/threads/${selectedAgent.id}/turns`, {
          method: "POST",
          body: JSON.stringify({
            text,
            clientId: createClientId(),
            projectId,
            approvalPolicy: thread?.approvalPolicy,
            networkAccess: thread?.networkAccess,
            skills: [],
            attachments: [],
          }),
        });
      }
      setPrompt("");
      setRevision((value) => value + 1);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "无法向子代理发送指令");
    } finally {
      setSending(false);
    }
  }

  async function interrupt() {
    if (!activeTurnId || sending) return;
    setSending(true);
    setActionError("");
    try {
      await api(`/api/threads/${selectedAgent.id}/interrupt`, {
        method: "POST",
        body: JSON.stringify({ turnId: activeTurnId }),
      });
      setRevision((value) => value + 1);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "无法停止子代理");
    } finally {
      setSending(false);
    }
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
        {selectedRequests.map((request) => request.method === "item/tool/requestUserInput"
          ? <UserInputCard key={request.id} request={request} onResolved={onRequestResolved} />
          : <ApprovalCard key={request.id} request={request} onResolved={onRequestResolved} />)}
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
      <footer className="subagent-panel-composer">
        {actionError && <div className="subagent-action-error"><AlertTriangle size={13} />{actionError}</div>}
        {waitingForRequest && <small>这个子代理正在等待你的批准或输入，请先处理上方请求。</small>}
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void sendFollowUp();
          }}
          placeholder={running ? "向正在运行的子代理追加指令…" : "继续给这个子代理分配工作…"}
          disabled={loading || sending || waitingForRequest || !thread?.projectId}
          rows={2}
        />
        <div>
          <span>{running ? <><CornerDownRight size={12} />立即影响当前执行</> : "Enter 发送，Shift+Enter 换行"}</span>
          {activeTurnId && <button className="ghost-button compact danger-text" disabled={sending} onClick={() => void interrupt()}><Square size={13} />停止</button>}
          {["failed", "errored", "interrupted"].includes(status) && <button className="secondary-button compact" disabled={sending || waitingForRequest} onClick={() => void sendFollowUp("请根据上一轮的失败原因重新尝试，并继续完成原任务。") }><RotateCcw size={13} />重试</button>}
          <button className="primary-button compact" disabled={!prompt.trim() || sending || waitingForRequest || !thread?.projectId} onClick={() => void sendFollowUp()}><Send size={13} />{sending ? "发送中…" : running ? "追加" : "继续"}</button>
        </div>
      </footer>
    </aside>
  );
}
