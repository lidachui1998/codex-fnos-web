import { ArrowLeft, ChevronRight, Code2, Eye, File, FileDiff, Folder, Image as ImageIcon, Maximize2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { Project, ThreadItem } from "../types";
import { DiffView, normalizedChangeKind } from "./DiffView";

type Entry = { name: string; path: string; type: "directory" | "file"; size: number | null };
type Change = { path: string; previousPath?: string; status?: string; kind: string; source?: string; diff?: string };
type Preview = { path: string; content: string; kind: "file" | "diff"; fileKind: "text" | "image"; mimeType?: string; dataUrl?: string };

function isMarkdown(path: string) {
  return /\.(?:md|markdown|mdown|mkd)$/i.test(path);
}

export function WorkspacePanel({ project, items, requestedFile, onClose }: { project: Project; items: ThreadItem[]; requestedFile?: { path: string; nonce: number } | null; onClose: () => void }) {
  const [tab, setTab] = useState<"changes" | "files">("changes");
  const [directory, setDirectory] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [gitChanges, setGitChanges] = useState<Change[]>([]);
  const [changeMessage, setChangeMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [markdownSource, setMarkdownSource] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sessionChanges = useMemo(() => items
    .filter((item) => item.type === "fileChange")
    .flatMap((item) => item.changes ?? [])
    .map((item) => ({ ...item, kind: normalizedChangeKind(item.kind), source: "session" })), [items]);
  const changes = useMemo(() => {
    const byPath = new Map<string, Change>();
    for (const item of [...gitChanges, ...sessionChanges]) byPath.set(item.path, { ...byPath.get(item.path), ...item });
    return [...byPath.values()];
  }, [gitChanges, sessionChanges]);

  async function loadFiles(path = directory) {
    setLoading(true); setError(""); setPreview(null);
    try {
      const result = await api<{ path: string; parent: string | null; entries: Entry[] }>(`/api/projects/${project.id}/files?path=${encodeURIComponent(path)}`);
      setDirectory(result.path); setParent(result.parent); setEntries(result.entries);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "目录读取失败");
    } finally { setLoading(false); }
  }

  async function loadChanges() {
    setLoading(true); setError(""); setPreview(null);
    try {
      const result = await api<{ changes: Change[]; message: string }>(`/api/projects/${project.id}/changes`);
      setGitChanges(result.changes ?? []); setChangeMessage(result.message || "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "改动读取失败");
    } finally { setLoading(false); }
  }

  async function openFile(path: string) {
    setLoading(true); setError("");
    try {
      const result = await api<{ path: string; kind: "text" | "image"; content?: string; mimeType?: string; dataUrl?: string }>(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`);
      setMarkdownSource(false);
      setPreview({ path: result.path, content: result.content ?? "", kind: "file", fileKind: result.kind, mimeType: result.mimeType, dataUrl: result.dataUrl });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "文件读取失败"); }
    finally { setLoading(false); }
  }

  async function openChange(change: Change) {
    if (change.diff) { setPreview({ path: change.path, content: change.diff, kind: "diff", fileKind: "text" }); return; }
    setLoading(true); setError("");
    try {
      const result = await api<{ path: string; diff: string }>(`/api/projects/${project.id}/diff?path=${encodeURIComponent(change.path)}`);
      setPreview({ path: result.path, content: result.diff, kind: "diff", fileKind: "text" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Diff 读取失败"); }
    finally { setLoading(false); }
  }

  useEffect(() => { setDirectory(""); setPreview(null); void loadChanges(); }, [project.id]);
  useEffect(() => {
    if (!requestedFile) return;
    setTab("files");
    void openFile(requestedFile.path);
  }, [requestedFile?.nonce]);

  return <aside className="workspace-inspector">
    <header><div><Code2 size={17} /><span><strong>项目文件</strong><small>{project.name}</small></span></div><button className="icon-button small" onClick={onClose} aria-label="关闭项目文件"><X size={17} /></button></header>
    <div className="inspector-tabs"><button className={tab === "changes" ? "active" : ""} onClick={() => { setTab("changes"); void loadChanges(); }}><FileDiff size={14} /> 改动 <em>{changes.length}</em></button><button className={tab === "files" ? "active" : ""} onClick={() => { setTab("files"); void loadFiles(""); }}><Folder size={14} /> 文件</button><button className="icon-button small" onClick={() => void (tab === "changes" ? loadChanges() : loadFiles())} aria-label="刷新"><RefreshCw size={14} className={loading ? "spin" : ""} /></button></div>
    {error && <div className="inspector-error">{error}</div>}
    {preview ? <div className="code-preview"><header><button className="icon-button small" onClick={() => setPreview(null)}><ArrowLeft size={15} /></button><span title={preview.path}>{preview.path}</span><div className="preview-actions">{preview.kind === "file" && preview.fileKind === "text" && isMarkdown(preview.path) && <button className="preview-mode-button" onClick={() => setMarkdownSource((value) => !value)}>{markdownSource ? <Eye size={13} /> : <Code2 size={13} />}{markdownSource ? "预览" : "源码"}</button>}<em>{preview.kind === "diff" ? "DIFF" : preview.fileKind === "image" ? "IMAGE" : isMarkdown(preview.path) && !markdownSource ? "MD" : "CODE"}</em></div></header>{preview.kind === "diff" ? <DiffView value={preview.content || "暂无内容"} className="workspace-diff" /> : preview.fileKind === "image" && preview.dataUrl ? <button className="file-image-preview" onClick={() => setExpandedImage(preview.dataUrl!)} title="点击放大图片"><img src={preview.dataUrl} alt={preview.path} /><span><Maximize2 size={15} /> 点击放大</span></button> : isMarkdown(preview.path) && !markdownSource ? <div className="file-markdown markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>{preview.content || "*暂无内容*"}</ReactMarkdown></div> : <pre className="code-source">{preview.content || "暂无内容"}</pre>}</div> : <div className="inspector-list">
      {tab === "changes" && <>{changeMessage && <div className="inspector-note">{changeMessage}</div>}{changes.map((change) => <button key={change.path} onClick={() => void openChange(change)}><span className={`change-badge ${change.kind}`}>{change.status?.trim() || change.kind.slice(0, 1).toUpperCase()}</span><span><strong>{change.path}</strong><small>{change.kind === "untracked" ? "未跟踪" : change.kind === "added" ? "新增" : change.kind === "deleted" ? "删除" : "已修改"}</small></span><ChevronRight size={14} /></button>)}{changes.length === 0 && !loading && <div className="inspector-empty">暂时没有检测到文件改动</div>}</>}
      {tab === "files" && <>{directory && <button onClick={() => void loadFiles(parent || "")}><ArrowLeft size={15} /><span><strong>返回上级</strong><small>{directory}</small></span></button>}{entries.map((entry) => <button key={entry.path} onClick={() => void (entry.type === "directory" ? loadFiles(entry.path) : openFile(entry.path))}>{entry.type === "directory" ? <Folder size={16} /> : /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name) ? <ImageIcon size={16} /> : <File size={16} />}<span><strong>{entry.name}</strong><small>{entry.type === "file" && entry.size !== null ? `${Math.max(1, Math.round(entry.size / 1024))} KB` : entry.path}</small></span><ChevronRight size={14} /></button>)}{entries.length === 0 && !loading && <div className="inspector-empty">这个目录是空的</div>}</>}
    </div>}
    {expandedImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="项目图片预览" onClick={() => setExpandedImage(null)}><button className="image-lightbox-close" onClick={() => setExpandedImage(null)} aria-label="关闭图片预览"><X size={22} /></button><img src={expandedImage} alt="放大的项目图片" onClick={(event) => event.stopPropagation()} /></div>}
  </aside>;
}
