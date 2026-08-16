import { AlertTriangle, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, Clock3, Copy, FileCode2, LoaderCircle, Maximize2, Pencil, RefreshCw, RotateCcw, TerminalSquare, UserRound, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ThreadItem } from "../types";
import { collabAgentStates, runningAgentStatuses, subagentStates, type AgentViewState } from "../subagents";
import { changeKindName, DiffView } from "./DiffView";

export type { AgentViewState } from "../subagents";

function workspaceFileHref(href: string | undefined, projectPath: string) {
  if (!href) return null;
  const value = href.trim();
  if (!value || /^(?:https?:|mailto:|tel:|data:|#)/i.test(value)) return null;
  if (/^file:/i.test(value) || /^[a-z]:[\\/]/i.test(value)) return value;
  const normalizedProject = projectPath.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedValue = value.replaceAll("\\", "/");
  if (normalizedValue.startsWith("/") && !normalizedValue.startsWith(`${normalizedProject}/`) && normalizedValue !== normalizedProject) return null;
  return value;
}

function userText(item: ThreadItem) {
  const value = (item.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "")
    .replace(/\s*<fnos_attachment name=("([^"]*)"|'([^']*)')>[\s\S]*?<\/fnos_attachment>/g, (_match, _quoted, doubleName, singleName) => `\n📎 ${doubleName || singleName || "附件"}`)
    .trim();
  const skillNames = [...value.matchAll(/(?:^|\s)\$([\w:-]+)/g)].map((match) => match[1]);
  const text = value.replace(/^(?:\$[\w:-]+\s*)+/, "").trim();
  return text || (skillNames.length > 0 ? `✨ 使用 Skills：${skillNames.join("、")}` : "");
}

function userImages(item: ThreadItem) {
  return item.content
    ?.filter((part) => part.type === "image" && typeof part.url === "string" && /^(?:data:image\/(?:png|jpeg|webp|gif);base64,|https?:\/\/)/i.test(part.url))
    .map((part) => part.url as string) ?? [];
}

function agentStatusLabel(status: string) {
  return ({
    pendingInit: "准备中",
    running: "运行中",
    inProgress: "运行中",
    completed: "已完成",
    errored: "失败",
    failed: "失败",
    interrupted: "已中断",
    shutdown: "已结束",
    notFound: "未找到",
  } as Record<string, string>)[status] ?? status;
}

function agentDisplayName(state: AgentViewState) {
  const path = state.path?.split("/").filter(Boolean).at(-1);
  return path || `子代理 ${state.id.slice(-8)}`;
}

function collabToolLabel(tool: string | undefined) {
  return ({
    spawnAgent: "启动子代理",
    sendInput: "向子代理追加任务",
    resumeAgent: "恢复子代理",
    wait: "等待子代理结果",
    closeAgent: "关闭子代理",
  } as Record<string, string>)[tool || ""] ?? "子代理协作";
}

function SubagentToolItem({ item, resolvedStates, onOpenSubagent }: { item: ThreadItem; resolvedStates: AgentViewState[]; onOpenSubagent?: (state: AgentViewState) => void }) {
  const [open, setOpen] = useState(false);
  const states = collabAgentStates(item).map((state) => {
    const resolved = resolvedStates.find((candidate) => candidate.id === state.id);
    return resolved ? { ...state, ...resolved } : state;
  });
  const running = item.status === "inProgress" || states.some((state) => runningAgentStatuses.has(state.status));
  const failed = item.status === "failed" || states.some((state) => ["errored", "failed"].includes(state.status));
  return (
    <article className={`subagent-card ${running ? "running" : failed ? "failed" : "completed"}`}>
      <button className="subagent-summary" onClick={() => setOpen(!open)}>
        <span className="subagent-icon">{running ? <LoaderCircle size={16} /> : failed ? <AlertTriangle size={16} /> : <Bot size={16} />}</span>
        <span><strong>{collabToolLabel(item.tool)}</strong><small>{states.length > 0 ? `${states.length} 个子代理 · ${states.map((state) => agentStatusLabel(state.status)).join("、")}` : agentStatusLabel(item.status || "completed")}</small></span>
        <em>{running ? "运行中" : failed ? "异常" : "已完成"}</em>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open && <div className="subagent-detail">
        {item.prompt && <p>{item.prompt}</p>}
        {states.map((state) => <button type="button" key={state.id} onClick={() => onOpenSubagent?.(state)} disabled={!onOpenSubagent} title="在右侧打开子代理会话"><span className={`subagent-state ${state.status}`}>{agentStatusLabel(state.status)}</span><strong>{agentDisplayName(state)}</strong>{state.message && <small>{state.message}</small>}<ChevronRight size={14} /></button>)}
        {item.model && <footer>模型 {item.model}{item.reasoningEffort ? ` · ${item.reasoningEffort}` : ""}</footer>}
      </div>}
    </article>
  );
}

function ToolItem({ item }: { item: ThreadItem }) {
  const [open, setOpen] = useState(false);
  const isCommand = item.type === "commandExecution";
  const isFile = item.type === "fileChange";
  const Icon = isCommand ? TerminalSquare : isFile ? FileCode2 : Wrench;
  const title = isCommand ? item.command : isFile ? `${item.changes?.length ?? 0} 个文件变更` : `${item.server ?? "工具"} · ${item.tool ?? item.type}`;
  const detail = isCommand ? item.aggregatedOutput : JSON.stringify(item.result ?? item.arguments ?? item.error ?? {}, null, 2);
  return (
    <article className="tool-item">
      <button className="tool-summary" onClick={() => setOpen(!open)}>
        <Icon size={16} />
        <span>{title || "正在执行工具"}</span>
        <em className={`status-dot ${item.status ?? "inProgress"}`}>{item.status === "completed" ? <CheckCircle2 size={14} /> : <LoaderCircle size={14} />}</em>
        {Number.isFinite(item.durationMs) && <small className="tool-duration"><Clock3 size={11} />{durationText(Number(item.durationMs))}</small>}
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open && (isFile
        ? <div className="tool-detail file-change-detail">{item.changes?.map((change, index) => <section key={`${change.path}-${index}`}><header><strong>{changeKindName(change.kind)}</strong><span>{change.path}</span></header><DiffView value={change.diff || "暂无 Diff 内容"} /></section>)}</div>
        : <pre className="tool-detail">{detail || "暂无输出"}</pre>)}
    </article>
  );
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // fnOS is often opened over a LAN HTTP address where the async Clipboard
    // API exists but is denied because the page is not a secure context.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器拒绝了复制操作");
}

type Props = {
  items: ThreadItem[];
  streamingItemId?: string | null;
  turnRunning?: boolean;
  activeTurnId?: string | null;
  activeTurnStartedAtMs?: number | null;
  retryProviders: RetryProviderOption[];
  retryProviderId: string;
  projectPath: string;
  onOpenFile: (path: string) => void;
  onSuggestion?: (text: string) => void;
  onResend: (item: ThreadItem, providerId: string) => void;
  onRegenerate: (item: ThreadItem, providerId: string) => void;
  onEditBranch: (item: ThreadItem) => void;
  onOpenSubagent?: (state: AgentViewState) => void;
  readOnly?: boolean;
};

export type RetryProviderOption = {
  id: string;
  name: string;
  model: string;
};

function durationText(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function itemDurationMs(item: ThreadItem) {
  if (Number.isFinite(item.turnDurationMs)) return Math.max(0, Number(item.turnDurationMs));
  if (Number.isFinite(item.turnStartedAt) && Number.isFinite(item.turnCompletedAt)) {
    return Math.max(0, (Number(item.turnCompletedAt) - Number(item.turnStartedAt)) * 1000);
  }
  return null;
}

export function Timeline({ items, streamingItemId, turnRunning, activeTurnId, activeTurnStartedAtMs, retryProviders, retryProviderId, projectPath, onOpenFile, onSuggestion, onResend, onRegenerate, onEditBranch, onOpenSubagent, readOnly = false }: Props) {
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(140);
  const [retryItemId, setRetryItemId] = useState<string | null>(null);
  const [draftRetryProviderId, setDraftRetryProviderId] = useState(retryProviderId);
  const [nowMs, setNowMs] = useState(Date.now());
  const renderableItems = useMemo(() => items.filter((item) => item.type !== "reasoning" || item.summary?.some((text) => text.trim())), [items]);
  const hiddenCount = Math.max(0, renderableItems.length - visibleLimit);
  const visibleItems = hiddenCount > 0 ? renderableItems.slice(hiddenCount) : renderableItems;
  const subagents = useMemo(() => subagentStates(items, activeTurnId ?? null), [items, activeTurnId]);
  const runningSubagents = subagents.filter((state) => runningAgentStatuses.has(state.status));
  const completedSubagents = subagents.filter((state) => state.status === "completed" || state.status === "shutdown");
  const failedSubagents = subagents.filter((state) => ["errored", "failed", "interrupted", "notFound"].includes(state.status));

  useEffect(() => {
    if (!turnRunning || !activeTurnStartedAtMs) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turnRunning, activeTurnStartedAtMs]);

  function retryControl(item: ThreadItem, label: string, run: (item: ThreadItem, providerId: string) => void, disabled = false) {
    const open = retryItemId === item.id;
    const fallbackProviderId = retryProviders.some((provider) => provider.id === retryProviderId)
      ? retryProviderId
      : retryProviders[0]?.id ?? "";
    return <div className="retry-control">
      <button disabled={disabled || retryProviders.length === 0} onClick={() => {
        setDraftRetryProviderId(fallbackProviderId);
        setRetryItemId(open ? null : item.id);
      }}><RefreshCw size={13} />{label}<ChevronDown size={11} /></button>
      {open && <div className="retry-provider-picker" role="dialog" aria-label="选择重试供应商">
        <label><span>使用供应商</span><select value={draftRetryProviderId} onChange={(event) => setDraftRetryProviderId(event.target.value)}>{retryProviders.map((provider) => <option key={provider.id || "official"} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></label>
        <small>只列出已启用或你当前明确选择的供应商，不会自动跳转。</small>
        <div><button className="retry-provider-cancel" onClick={() => setRetryItemId(null)}>取消</button><button className="retry-provider-submit" onClick={() => { setRetryItemId(null); run(item, draftRetryProviderId); }}>开始重试</button></div>
      </div>}
    </div>;
  }

  async function copyItem(item: ThreadItem, value: string) {
    await copyText(value);
    setCopiedId(item.id);
    window.setTimeout(() => setCopiedId((current) => current === item.id ? null : current), 1400);
  }
  if (items.length === 0) {
    return (
      <div className="conversation-empty">
        <div className="empty-orbit"><Bot size={27} /></div>
        <h2>从一个具体目标开始</h2>
        <p>描述你想创建、修改或排查的内容。Codex 会读取当前项目，并在执行敏感操作前请求确认。</p>
        <div className="suggestion-grid">
          {["检查这个项目并告诉我如何运行", "帮我实现一个新功能并补齐测试", "分析当前错误并给出修复方案"].map((text) => (
            <button key={text} onClick={() => onSuggestion?.(text)}>{text}</button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="timeline">
      {hiddenCount > 0 && <button className="load-earlier" onClick={() => setVisibleLimit((value) => value + 120)}><RotateCcw size={14} />加载更早的 {Math.min(hiddenCount, 120)} 项</button>}
      {visibleItems.map((item, visibleIndex) => {
        if (item.type === "userMessage") {
          const text = userText(item);
          const images = userImages(item);
          return <article className="message user-message" key={item.id}><div className="message-avatar"><UserRound size={16} /></div><div className="message-body"><div className="message-label">你</div>{images.length > 0 && <div className={`message-images ${images.length > 1 ? "multiple" : ""}`}>{images.map((url, index) => <button key={`${item.id}-${index}`} onClick={() => setPreviewImage(url)} title="点击放大图片"><img src={url} alt={`发送的图片 ${index + 1}`} loading="lazy" /><span><Maximize2 size={14} /></span></button>)}</div>}{text && <div className="message-text">{text}</div>}{!readOnly && <div className="message-actions"><button onClick={() => void copyItem(item, text)}>{copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === item.id ? "已复制" : "复制"}</button>{retryControl(item, "重新发送", onResend, Boolean(turnRunning))}<button disabled={!item.turnId || turnRunning} onClick={() => onEditBranch(item)}><Pencil size={13} />编辑并分支</button></div>}</div></article>;
        }
        if (item.type === "agentMessage" || item.type === "plan") {
          const duration = itemDurationMs(item);
          return <article className="message agent-message" key={item.id}><div className="message-avatar agent"><Bot size={16} /></div><div className="message-body"><div className="message-label">Codex{duration !== null && <span className="execution-duration"><Clock3 size={11} />执行 {durationText(duration)}</span>}</div><div className="message-text markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href, node: _node, ...props }) => {
            const file = workspaceFileHref(href, projectPath);
            return file
              ? <a {...props} href={href} className="workspace-file-link" onClick={(event) => { event.preventDefault(); onOpenFile(file); }} title="在项目文件中打开">{children}</a>
              : <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
          } }}>{item.text ?? ""}</ReactMarkdown>{streamingItemId === item.id && <span className="stream-caret" />}</div>{!readOnly && streamingItemId !== item.id && <div className="message-actions"><button onClick={() => void copyItem(item, item.text ?? "")}>{copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === item.id ? "已复制" : "复制"}</button>{retryControl(item, "重新生成", onRegenerate, !item.turnId || Boolean(turnRunning))}</div>}</div></article>;
        }
        if (item.type === "collabToolCall") return <SubagentToolItem item={item} resolvedStates={subagents} key={item.id} onOpenSubagent={onOpenSubagent} />;
        if (item.type === "subAgentActivity") {
          const state = subagents.find((entry) => entry.id === item.agentThreadId) ?? { id: item.agentThreadId || "", path: item.agentPath, status: item.kind === "interrupted" ? "interrupted" : turnRunning ? "running" : "completed" };
          return <button type="button" className="subagent-activity" key={item.id} onClick={() => state.id && onOpenSubagent?.(state)} disabled={!state.id || !onOpenSubagent} title="在右侧打开子代理会话"><Bot size={13} /><span>{agentStatusLabel(state.status)}</span><strong>{agentDisplayName(state)}</strong><ChevronRight size={13} /></button>;
        }
        if (["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(item.type)) {
          return <ToolItem item={item} key={item.id} />;
        }
        if (item.type === "turnError") {
          const previousUser = renderableItems.slice(0, hiddenCount + visibleIndex).reverse().find((entry) => entry.type === "userMessage");
          const duration = itemDurationMs(item);
          return <article className={`turn-error-card ${item.retrying ? "retrying" : ""}`} key={item.id}><AlertTriangle size={18} /><div><strong>{item.retrying ? "模型请求暂时失败，正在自动重试" : "这次没有得到模型回复"}{duration !== null && <span className="execution-duration"><Clock3 size={11} />执行 {durationText(duration)}</span>}</strong><p>{item.text || "未知错误"}</p><div><button onClick={() => void copyItem(item, item.text ?? "")}>{copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === item.id ? "已复制" : "复制错误"}</button>{previousUser && retryControl(item, "重试", (_item, providerId) => item.turnId ? onRegenerate(item, providerId) : onResend(previousUser, providerId), !previousUser || Boolean(turnRunning) || Boolean(item.retrying))}</div></div></article>;
        }
        if (item.type === "reasoning") {
          return <div className="reasoning-row summary" key={item.id}>{item.summary?.join(" ")}</div>;
        }
        return null;
      })}
      {subagents.length > 0 && <section className={`subagent-live-panel ${runningSubagents.length === 0 ? "settled" : ""}`} aria-live="polite">
        <header>{runningSubagents.length > 0 ? <LoaderCircle size={15} /> : <CheckCircle2 size={15} />}<span><strong>{runningSubagents.length > 0 ? "Codex 正在并行处理" : "子代理任务已结束"}</strong><small>{runningSubagents.length > 0 ? `${runningSubagents.length} 个运行中` : "所有子代理均已退出运行状态"} · {completedSubagents.length} 个完成{failedSubagents.length > 0 ? ` · ${failedSubagents.length} 个异常` : ""} · 点击可查看完整会话</small></span><em>{subagents.length}</em></header>
        <div>{subagents.map((state) => <button type="button" key={state.id} onClick={() => onOpenSubagent?.(state)} disabled={!onOpenSubagent} title="在右侧打开子代理会话"><i className={runningAgentStatuses.has(state.status) ? "running" : state.status} /><strong>{agentDisplayName(state)}</strong><small>{agentStatusLabel(state.status)}</small><ChevronRight size={12} /></button>)}</div>
      </section>}
      {turnRunning && !streamingItemId && <div className="reasoning-row active"><LoaderCircle size={14} /> 正在处理…</div>}
      {turnRunning && activeTurnStartedAtMs && <div className="turn-duration-live"><Clock3 size={12} />已执行 {durationText(nowMs - activeTurnStartedAtMs)}</div>}
      {previewImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setPreviewImage(null)}><button className="image-lightbox-close" onClick={() => setPreviewImage(null)} aria-label="关闭图片预览"><X size={22} /></button><img src={previewImage} alt="放大的聊天图片" onClick={(event) => event.stopPropagation()} /></div>}
    </div>
  );
}

export { workspaceFileHref };
