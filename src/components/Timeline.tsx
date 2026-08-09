import { Bot, Check, CheckCircle2, ChevronDown, ChevronRight, Copy, FileCode2, LoaderCircle, Maximize2, Pencil, RefreshCw, RotateCcw, TerminalSquare, UserRound, Wrench, X } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ThreadItem } from "../types";
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
  projectPath: string;
  onOpenFile: (path: string) => void;
  onSuggestion?: (text: string) => void;
  onResend: (item: ThreadItem) => void;
  onRegenerate: (item: ThreadItem) => void;
  onEditBranch: (item: ThreadItem) => void;
};

export function Timeline({ items, streamingItemId, turnRunning, projectPath, onOpenFile, onSuggestion, onResend, onRegenerate, onEditBranch }: Props) {
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(140);
  const renderableItems = useMemo(() => items.filter((item) => item.type !== "reasoning" || item.summary?.some((text) => text.trim())), [items]);
  const hiddenCount = Math.max(0, renderableItems.length - visibleLimit);
  const visibleItems = hiddenCount > 0 ? renderableItems.slice(hiddenCount) : renderableItems;

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
      {visibleItems.map((item) => {
        if (item.type === "userMessage") {
          const text = userText(item);
          const images = userImages(item);
          return <article className="message user-message" key={item.id}><div className="message-avatar"><UserRound size={16} /></div><div className="message-body"><div className="message-label">你</div>{images.length > 0 && <div className={`message-images ${images.length > 1 ? "multiple" : ""}`}>{images.map((url, index) => <button key={`${item.id}-${index}`} onClick={() => setPreviewImage(url)} title="点击放大图片"><img src={url} alt={`发送的图片 ${index + 1}`} loading="lazy" /><span><Maximize2 size={14} /></span></button>)}</div>}{text && <div className="message-text">{text}</div>}<div className="message-actions"><button onClick={() => void copyItem(item, text)}>{copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === item.id ? "已复制" : "复制"}</button><button onClick={() => onResend(item)}><RefreshCw size={13} />重新发送</button><button disabled={!item.turnId || turnRunning} onClick={() => onEditBranch(item)}><Pencil size={13} />编辑并分支</button></div></div></article>;
        }
        if (item.type === "agentMessage" || item.type === "plan") {
          return <article className="message agent-message" key={item.id}><div className="message-avatar agent"><Bot size={16} /></div><div className="message-body"><div className="message-label">Codex</div><div className="message-text markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href, node: _node, ...props }) => {
            const file = workspaceFileHref(href, projectPath);
            return file
              ? <a {...props} href={href} className="workspace-file-link" onClick={(event) => { event.preventDefault(); onOpenFile(file); }} title="在项目文件中打开">{children}</a>
              : <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
          } }}>{item.text ?? ""}</ReactMarkdown>{streamingItemId === item.id && <span className="stream-caret" />}</div>{streamingItemId !== item.id && <div className="message-actions"><button onClick={() => void copyItem(item, item.text ?? "")}>{copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === item.id ? "已复制" : "复制"}</button><button disabled={!item.turnId || turnRunning} onClick={() => onRegenerate(item)}><RefreshCw size={13} />重新生成</button></div>}</div></article>;
        }
        if (["commandExecution", "fileChange", "mcpToolCall", "collabToolCall", "webSearch"].includes(item.type)) {
          return <ToolItem item={item} key={item.id} />;
        }
        if (item.type === "reasoning") {
          return <div className="reasoning-row summary" key={item.id}>{item.summary?.join(" ")}</div>;
        }
        return null;
      })}
      {turnRunning && !streamingItemId && <div className="reasoning-row active"><LoaderCircle size={14} /> 正在处理…</div>}
      {previewImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setPreviewImage(null)}><button className="image-lightbox-close" onClick={() => setPreviewImage(null)} aria-label="关闭图片预览"><X size={22} /></button><img src={previewImage} alt="放大的聊天图片" onClick={(event) => event.stopPropagation()} /></div>}
    </div>
  );
}

export { workspaceFileHref };
