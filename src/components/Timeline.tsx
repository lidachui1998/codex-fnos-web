import { Activity, AlertTriangle, Bot, BrainCircuit, Check, CheckCircle2, ChevronDown, ChevronRight, Clock3, Copy, ExternalLink, FileCode2, Globe2, LoaderCircle, Maximize2, Pencil, RefreshCw, RotateCcw, Search, TerminalSquare, UserRound, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ThreadItem } from "../types";
import { toolDetail, toolFailure } from "../tool-diagnostics";
import { durationText } from "../execution-duration";
import { changeKindName, DiffView } from "./DiffView";

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

function compactText(value: string | undefined, limit = 150) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

type WebSource = { url: string; title: string; snippet: string; fetchedAt: number | null };

function webUrl(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^https?:\/\//i.test(text)) return null;
  try { return new URL(text).toString(); } catch { return null; }
}

function sourceRecord(value: unknown, fetchedAt: number | null): WebSource | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = [record, record.source, record.document, record.page].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  const first = (keys: string[]) => {
    for (const item of nested) for (const key of keys) if (typeof item[key] === "string" && String(item[key]).trim()) return String(item[key]).trim();
    return "";
  };
  const url = webUrl(first(["url", "link", "uri", "source_url", "sourceUrl"]));
  if (!url) return null;
  const title = first(["title", "name", "headline"]) || new URL(url).hostname;
  const snippet = compactText(first(["snippet", "excerpt", "description", "text", "content"]), 300);
  return { url, title, snippet, fetchedAt };
}

function webSearchSources(item: ThreadItem) {
  const fetchedAt = Number.isFinite(item.observedAt) ? Number(item.observedAt) : null;
  const sources = (Array.isArray(item.results) ? item.results : []).map((result) => sourceRecord(result, fetchedAt)).filter((source): source is WebSource => Boolean(source));
  const actionUrl = webUrl(item.action?.url);
  if (actionUrl) sources.push({ url: actionUrl, title: new URL(actionUrl).hostname, snippet: item.action?.pattern ? `页内查找：${item.action.pattern}` : "模型打开了这个网页", fetchedAt });
  return sources;
}

function markdownSources(text: string, fetchedAt: number | null) {
  const sources: WebSource[] = [];
  const pattern = /\[([^\]]+)]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/gi;
  for (const match of text.matchAll(pattern)) {
    const url = webUrl(match[2]);
    if (!url) continue;
    const start = Math.max(0, (match.index ?? 0) - 120);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 160);
    const snippet = compactText(text.slice(start, end).replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1"), 280);
    sources.push({ url, title: compactText(match[1], 140) || new URL(url).hostname, snippet, fetchedAt });
  }
  return sources;
}

function dedupeSources(values: WebSource[]) {
  const sources = new Map<string, WebSource>();
  for (const value of values) {
    const existing = sources.get(value.url);
    sources.set(value.url, existing ? {
      ...existing,
      title: existing.title || value.title,
      snippet: existing.snippet || value.snippet,
      fetchedAt: existing.fetchedAt ?? value.fetchedAt,
    } : value);
  }
  return [...sources.values()].slice(0, 12);
}

function sourceTime(value: number | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "本次回答";
}

function WebSources({ sources, compact = false }: { sources: WebSource[]; compact?: boolean }) {
  if (!sources.length) return null;
  return <section className={`web-sources ${compact ? "compact" : ""}`}>
    <header><Globe2 size={14} /><strong>网页来源</strong><span>{sources.length}</span></header>
    <div>{sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>
      <em>{index + 1}</em><span><strong>{source.title}</strong><small>{new URL(source.url).hostname} · 抓取 {sourceTime(source.fetchedAt)}</small>{source.snippet && <p>{source.snippet}</p>}</span><ExternalLink size={13} />
    </a>)}</div>
  </section>;
}

function toolStatus(item: ThreadItem) {
  if (toolFailure(item)) return { label: "失败", icon: <AlertTriangle size={14} /> };
  if (item.status === "completed") return { label: "完成", icon: <CheckCircle2 size={14} /> };
  if (["failed", "declined"].includes(item.status ?? "")) return { label: item.status === "declined" ? "已拒绝" : "失败", icon: <AlertTriangle size={14} /> };
  return { label: "执行中", icon: <LoaderCircle size={14} /> };
}

function ToolItem({ item }: { item: ThreadItem }) {
  const [open, setOpen] = useState(item.status === "inProgress");
  const previousStatus = useRef(item.status);
  const isCommand = item.type === "commandExecution";
  const isFile = item.type === "fileChange";
  const isSearch = item.type === "webSearch";
  const Icon = isCommand ? TerminalSquare : isFile ? FileCode2 : isSearch ? Search : Wrench;
  const kind = isCommand ? "命令" : isFile ? "文件" : isSearch ? "搜索" : item.type === "contextCompaction" ? "上下文" : "工具";
  const title = isCommand
    ? compactText(item.command) || "正在执行命令"
    : isFile
      ? `${item.changes?.length ?? 0} 个文件变更`
      : item.type === "contextCompaction"
        ? "整理会话上下文"
        : isSearch
          ? compactText(item.action?.query || item.action?.queries?.join(" · ") || item.query) || "网页搜索"
          : `${item.server ? `${item.server} · ` : ""}${item.tool ?? item.type}`;
  const detail = isCommand
    ? item.aggregatedOutput
    : toolDetail(item);
  const status = toolStatus(item);
  const failure = toolFailure(item);

  useEffect(() => {
    if (item.status === "inProgress" && (item.aggregatedOutput || item.progress)) setOpen(true);
    else if (previousStatus.current === "inProgress" && item.status !== "inProgress") setOpen(false);
    previousStatus.current = item.status;
  }, [item.aggregatedOutput, item.progress, item.status]);

  return (
    <article className={`tool-item ${failure ? "failed" : item.status ?? "inProgress"}`}>
      <button className="tool-summary" onClick={() => setOpen(!open)}>
        <Icon size={16} />
        <b>{kind}</b>
        <span>{title || "正在执行工具"}</span>
        <em className={`status-dot ${failure ? "failed" : item.status ?? "inProgress"}`}>{status.icon}<i>{status.label}</i></em>
        {Number.isFinite(item.durationMs) && <small className="tool-duration"><Clock3 size={11} />{durationText(Number(item.durationMs))}</small>}
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {failure && <div className="tool-failure">{isCommand && <strong>命令失败 · {Number.isFinite(item.exitCode) ? `退出码 ${item.exitCode}` : "未提供退出码"}</strong>}<span>{failure.message}</span>{failure.hint && <small>{failure.hint}</small>}</div>}
      {open && (isFile
        ? <div className="tool-detail file-change-detail">{item.changes?.map((change, index) => <section key={`${change.path}-${index}`}><header><strong>{changeKindName(change.kind)}</strong><span>{change.path}</span></header><DiffView value={change.diff || "暂无 Diff 内容"} /></section>)}</div>
        : isSearch && webSearchSources(item).length > 0
          ? <div className="tool-detail web-search-detail"><WebSources sources={webSearchSources(item)} compact /></div>
          : isCommand
            ? <div className="command-detail"><div className="command-context"><span>工作目录：<code>{item.cwd || "未记录"}</code></span><span>退出码：{Number.isFinite(item.exitCode) ? item.exitCode : "未提供"}</span><span>原始命令</span><pre>{item.command || "未记录"}</pre></div><pre className="tool-detail">{detail || (item.status === "inProgress" ? "正在等待输出…" : "暂无输出")}</pre></div>
            : <pre className="tool-detail">{detail || (item.status === "inProgress" ? "正在等待输出…" : "暂无输出")}</pre>)}
    </article>
  );
}

function ReasoningItem({ item, active }: { item: ThreadItem; active: boolean }) {
  const [open, setOpen] = useState(active);
  const previousActive = useRef(active);
  const sections = item.summary?.filter((text) => text.trim()) ?? [];
  const characterCount = sections.reduce((total, text) => total + text.length, 0);

  useEffect(() => {
    if (active) setOpen(true);
    else if (previousActive.current) setOpen(false);
    previousActive.current = active;
  }, [active]);

  return <section className={`reasoning-card ${active ? "active" : "history"}`}>
    <button onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span className="reasoning-icon"><BrainCircuit size={15} /></span>
      <span><strong>{active ? "正在思考" : "思考过程"}</strong><small>{sections.length > 1 ? `${sections.length} 段 · ` : ""}{characterCount.toLocaleString()} 字</small></span>
      {active && <em><LoaderCircle size={12} />生成中</em>}
      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
    </button>
    {open && <div className="reasoning-content">{sections.map((text, index) => <p key={`${item.id}-${index}`}>{text}</p>)}</div>}
  </section>;
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
  activeTurnStartedAtMs?: number | null;
  lastTurnActivityAtMs?: number | null;
  retryProviders: RetryProviderOption[];
  retryProviderId: string;
  projectPath: string;
  onOpenFile: (path: string) => void;
  onSuggestion?: (text: string) => void;
  onResend: (item: ThreadItem, providerId: string) => void;
  onRegenerate: (item: ThreadItem, providerId: string) => void;
  onEditBranch: (item: ThreadItem) => void;
  readOnly?: boolean;
};

export type RetryProviderOption = {
  id: string;
  name: string;
  model: string;
};

function itemDurationMs(item: ThreadItem) {
  if (Number.isFinite(item.turnDurationMs)) return Math.max(0, Number(item.turnDurationMs));
  if (Number.isFinite(item.turnStartedAt) && Number.isFinite(item.turnCompletedAt)) {
    return Math.max(0, (Number(item.turnCompletedAt) - Number(item.turnStartedAt)) * 1000);
  }
  return null;
}

export function Timeline({ items, streamingItemId, turnRunning, activeTurnStartedAtMs, lastTurnActivityAtMs, retryProviders, retryProviderId, projectPath, onOpenFile, onSuggestion, onResend, onRegenerate, onEditBranch, readOnly = false }: Props) {
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(140);
  const [retryItemId, setRetryItemId] = useState<string | null>(null);
  const [draftRetryProviderId, setDraftRetryProviderId] = useState(retryProviderId);
  const [nowMs, setNowMs] = useState(Date.now());
  const renderableItems = useMemo(() => items.filter((item) => !["collabToolCall", "subAgentActivity"].includes(item.type) && (item.type !== "reasoning" || item.summary?.some((text) => text.trim()))), [items]);
  const hiddenCount = Math.max(0, renderableItems.length - visibleLimit);
  const visibleItems = hiddenCount > 0 ? renderableItems.slice(hiddenCount) : renderableItems;
  const latestNonUserItem = [...visibleItems].reverse().find((item) => item.type !== "userMessage" && item.type !== "turnError");
  const recentActivityItem = turnRunning && latestNonUserItem && (latestNonUserItem.type === "reasoning" || latestNonUserItem.status === "inProgress" || latestNonUserItem.id === streamingItemId)
    ? latestNonUserItem
    : null;
  const activeReasoningId = turnRunning && recentActivityItem?.type === "reasoning" ? recentActivityItem.id : null;
  const historyMessages = renderableItems.filter((item) => item.type === "userMessage" || item.type === "agentMessage").length;
  const historySteps = renderableItems.filter((item) => ["commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall", "contextCompaction"].includes(item.type)).length;
  const silenceMs = turnRunning && lastTurnActivityAtMs ? Math.max(0, nowMs - lastTurnActivityAtMs) : 0;
  const activityTitle = recentActivityItem?.type === "commandExecution"
    ? "正在执行命令"
    : recentActivityItem?.type === "fileChange"
      ? "正在整理文件修改"
      : recentActivityItem?.type === "mcpToolCall" || recentActivityItem?.type === "dynamicToolCall"
        ? "正在调用工具"
        : recentActivityItem?.type === "reasoning"
          ? "模型正在思考"
          : streamingItemId
            ? "正在生成回复"
            : "等待模型继续响应";
  const activityDetail = silenceMs >= 90_000
    ? `已有 ${durationText(silenceMs)}没有新事件，上游请求仍在等待；需要时可停止后重试。`
    : silenceMs >= 30_000
      ? "暂时没有新事件，但任务和连接仍处于运行状态。"
      : "连接正常，新的推理、命令和工具进度会继续显示在这里。";

  useEffect(() => {
    if (!turnRunning) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turnRunning]);

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
      {renderableItems.length > 4 && <div className="history-overview"><Clock3 size={13} /><span>会话记录</span><small>{historyMessages} 条对话{historySteps > 0 ? ` · ${historySteps} 个执行步骤` : ""}</small></div>}
      {hiddenCount > 0 && <button className="load-earlier" onClick={() => setVisibleLimit((value) => value + 120)}><RotateCcw size={14} />加载更早的 {Math.min(hiddenCount, 120)} 项</button>}
      {visibleItems.map((item, visibleIndex) => {
        if (item.type === "userMessage") {
          const text = userText(item);
          const images = userImages(item);
          return <article className="message user-message" key={item.id}><div className="message-avatar"><UserRound size={16} /></div><div className="message-body"><div className="message-label">你</div>{images.length > 0 && <div className={`message-images ${images.length > 1 ? "multiple" : ""}`}>{images.map((url, index) => <button key={`${item.id}-${index}`} onClick={() => setPreviewImage(url)} title="点击放大图片"><img src={url} alt={`发送的图片 ${index + 1}`} loading="lazy" /><span><Maximize2 size={14} /></span></button>)}</div>}{text && <div className="message-text">{text}</div>}{!readOnly && <div className="message-actions"><button onClick={() => void copyItem(item, text)}>{copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === item.id ? "已复制" : "复制"}</button>{retryControl(item, "重新发送", onResend, Boolean(turnRunning))}<button disabled={!item.turnId || turnRunning} onClick={() => onEditBranch(item)}><Pencil size={13} />编辑并分支</button></div>}</div></article>;
        }
        if (item.type === "agentMessage" || item.type === "plan") {
          const duration = itemDurationMs(item);
          const relatedSearches = items.filter((entry) => entry.type === "webSearch" && (!item.turnId || entry.turnId === item.turnId));
          const fetchedAt = relatedSearches.find((entry) => Number.isFinite(entry.observedAt))?.observedAt
            ?? (Number.isFinite(item.turnCompletedAt) ? Number(item.turnCompletedAt) * 1000 : null);
          const sources = dedupeSources([
            ...relatedSearches.flatMap(webSearchSources),
            ...markdownSources(item.text ?? "", fetchedAt ? Number(fetchedAt) : null),
          ]);
          return <article className="message agent-message" key={item.id}><div className="message-avatar agent"><Bot size={16} /></div><div className="message-body"><div className="message-label">Codex{duration !== null && <span className="execution-duration"><Clock3 size={11} />执行 {durationText(duration)}</span>}</div><div className="message-text markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href, node: _node, ...props }) => {
            const file = workspaceFileHref(href, projectPath);
            return file
              ? <a {...props} href={href} className="workspace-file-link" onClick={(event) => { event.preventDefault(); onOpenFile(file); }} title="在项目文件中打开">{children}</a>
              : <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
          } }}>{item.text ?? ""}</ReactMarkdown>{streamingItemId === item.id && <span className="stream-caret" />}</div><WebSources sources={sources} />{!readOnly && streamingItemId !== item.id && <div className="message-actions"><button onClick={() => void copyItem(item, item.text ?? "")}>{copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === item.id ? "已复制" : "复制"}</button>{retryControl(item, "重新生成", onRegenerate, !item.turnId || Boolean(turnRunning))}</div>}</div></article>;
        }
        if (["commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall", "contextCompaction"].includes(item.type)) {
          return <ToolItem item={item} key={item.id} />;
        }
        if (item.type === "turnError") {
          const previousUser = renderableItems.slice(0, hiddenCount + visibleIndex).reverse().find((entry) => entry.type === "userMessage");
          const duration = itemDurationMs(item);
          return <article className={`turn-error-card ${item.retrying ? "retrying" : ""}`} key={item.id}><AlertTriangle size={18} /><div><strong>{item.retrying ? "模型请求暂时失败，正在自动重试" : "这次没有得到模型回复"}{duration !== null && <span className="execution-duration"><Clock3 size={11} />执行 {durationText(duration)}</span>}</strong><p>{item.text || "未知错误"}</p><div><button onClick={() => void copyItem(item, item.text ?? "")}>{copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === item.id ? "已复制" : "复制错误"}</button>{previousUser && retryControl(item, "重试", (_item, providerId) => item.turnId ? onRegenerate(item, providerId) : onResend(previousUser, providerId), !previousUser || Boolean(turnRunning) || Boolean(item.retrying))}</div></div></article>;
        }
        if (item.type === "reasoning") {
          return <ReasoningItem item={item} active={item.id === activeReasoningId} key={item.id} />;
        }
        return null;
      })}
      {turnRunning && <div className={`activity-card ${silenceMs >= 90_000 ? "quiet" : ""}`}><span><Activity size={16} /></span><div><strong>{activityTitle}</strong><small>{activityDetail}</small></div>{activeTurnStartedAtMs && <em><Clock3 size={11} />{durationText(nowMs - activeTurnStartedAtMs)}</em>}</div>}
      {previewImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setPreviewImage(null)}><button className="image-lightbox-close" onClick={() => setPreviewImage(null)} aria-label="关闭图片预览"><X size={22} /></button><img src={previewImage} alt="放大的聊天图片" onClick={(event) => event.stopPropagation()} /></div>}
    </div>
  );
}

export { workspaceFileHref };
