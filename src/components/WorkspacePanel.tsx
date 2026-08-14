import { ArrowLeft, Check, ChevronRight, Code2, Copy, Download, ExternalLink, Eye, File, FileDiff, Folder, FolderOpen, Image as ImageIcon, Maximize2, PackageOpen, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { openFnosFile, openFnosFileManager, projectAbsolutePath } from "../fnos-sdk";
import type { Project, ThreadItem } from "../types";
import { DiffView, normalizedChangeKind } from "./DiffView";

type Entry = { name: string; path: string; type: "directory" | "file"; size: number | null };
type Change = { path: string; previousPath?: string; status?: string; kind: string; source?: string; diff?: string };
type Preview = { path: string; content: string; kind: "file" | "diff"; fileKind: "text" | "image"; mimeType?: string; dataUrl?: string; previewError?: string };
type Artifact = { name: string; path: string; size: number; modifiedAt: number; kind: "html" | "document" | "image" | "video" | "audio" | "archive" | "package" | "file"; mimeType: string };

function isMarkdown(path: string) {
  return /\.(?:md|markdown|mdown|mkd)$/i.test(path);
}

function cleanFileReference(value: string) {
  let result = value;
  if (/^file:/i.test(result)) {
    try {
      result = decodeURIComponent(new URL(result).pathname);
      if (/^\/[a-z]:\//i.test(result)) result = result.slice(1);
    } catch {
      // Keep the original value so the server can return a useful validation error.
    }
  }
  return result.replace(/#L?\d+(?:-L?\d+)?$/i, "").replace(/:(\d+)(?::\d+)?$/, "");
}

export function WorkspacePanel({ project, items, requestedFile, onClose }: { project: Project; items: ThreadItem[]; requestedFile?: { path: string; nonce: number } | null; onClose: () => void }) {
  const [tab, setTab] = useState<"changes" | "files" | "artifacts">("changes");
  const [directory, setDirectory] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [gitChanges, setGitChanges] = useState<Change[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [changeMessage, setChangeMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [markdownSource, setMarkdownSource] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedPath, setCopiedPath] = useState(false);
  const [notice, setNotice] = useState("");
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

  async function loadArtifacts() {
    setLoading(true); setError(""); setPreview(null);
    try {
      const result = await api<{ data: Artifact[] }>(`/api/projects/${project.id}/artifacts?limit=160`);
      setArtifacts(result.data ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "产物读取失败");
    } finally { setLoading(false); }
  }

  async function openFile(path: string) {
    setLoading(true); setError("");
    try {
      const result = await api<{ path: string; kind: "text" | "image"; content?: string; mimeType?: string; dataUrl?: string }>(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`);
      setMarkdownSource(false);
      setPreview({ path: result.path, content: result.content ?? "", kind: "file", fileKind: result.kind, mimeType: result.mimeType, dataUrl: result.dataUrl });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "文件读取失败";
      setPreview({ path: cleanFileReference(path), content: "", kind: "file", fileKind: "text", previewError: message });
    }
    finally { setLoading(false); }
  }

  function relativePreviewPath() {
    const value = cleanFileReference(preview?.path || "").replaceAll("\\", "/");
    const root = project.path.replaceAll("\\", "/").replace(/\/+$/, "");
    return value.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? value.slice(root.length + 1) : value;
  }

  function downloadPreview() {
    if (!preview || preview.kind !== "file") return;
    const anchor = document.createElement("a");
    anchor.href = `/api/projects/${project.id}/file/download?path=${encodeURIComponent(preview.path)}`;
    anchor.download = preview.path.split(/[\\/]/).pop() || "download";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function openBrowserPreview(path: string) {
    window.open(`/api/projects/${project.id}/file/view?path=${encodeURIComponent(path)}`, "_blank", "noopener,noreferrer");
  }

  function openArtifact(artifact: Artifact) {
    setPreview({
      path: cleanFileReference(artifact.path),
      content: "",
      kind: "file",
      fileKind: "text",
      previewError: "这是项目产物，可在新标签页预览、下载，或交给飞牛文件管理器打开。",
    });
  }

  async function openWithFnos(path: string, containingFolder = false) {
    const absolutePath = projectAbsolutePath(project, cleanFileReference(path));
    try {
      if (containingFolder) {
        const folder = absolutePath.replace(/[\\/][^\\/]+$/, "") || project.path;
        await openFnosFileManager(folder);
        setNotice("已在飞牛文件管理器中定位");
      } else {
        await openFnosFile(absolutePath);
        setNotice("已交给飞牛文件管理器打开");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法调用飞牛文件管理器");
    }
    window.setTimeout(() => setNotice(""), 1_800);
  }

  async function copyNasPath() {
    if (!preview) return;
    const path = relativePreviewPath();
    const fullPath = projectAbsolutePath(project, path);
    try {
      await navigator.clipboard.writeText(fullPath);
    } catch {
      const field = document.createElement("textarea");
      field.value = fullPath; field.style.position = "fixed"; field.style.opacity = "0";
      document.body.appendChild(field); field.select(); document.execCommand("copy"); field.remove();
    }
    setCopiedPath(true);
    window.setTimeout(() => setCopiedPath(false), 1_600);
  }

  function openContainingFolder() {
    const path = relativePreviewPath();
    setTab("files");
    void loadFiles(path.split("/").slice(0, -1).join("/"));
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
    <header><div><Code2 size={17} /><span><strong>项目与产物</strong><small>{project.name}</small></span></div><button className="icon-button small" onClick={onClose} aria-label="关闭项目文件"><X size={17} /></button></header>
    <div className="inspector-tabs"><button className={tab === "changes" ? "active" : ""} onClick={() => { setTab("changes"); void loadChanges(); }}><FileDiff size={14} /> 改动 <em>{changes.length}</em></button><button className={tab === "files" ? "active" : ""} onClick={() => { setTab("files"); void loadFiles(""); }}><Folder size={14} /> 文件</button><button className={tab === "artifacts" ? "active" : ""} onClick={() => { setTab("artifacts"); void loadArtifacts(); }}><PackageOpen size={14} /> 产物 <em>{artifacts.length}</em></button><button className="icon-button small" onClick={() => void (tab === "changes" ? loadChanges() : tab === "files" ? loadFiles() : loadArtifacts())} aria-label="刷新"><RefreshCw size={14} className={loading ? "spin" : ""} /></button></div>
    {error && <div className="inspector-error">{error}</div>}
    {notice && <div className="inspector-note">{notice}</div>}
    {preview ? <div className="code-preview">
      <header>
        <button className="icon-button small" onClick={() => setPreview(null)}><ArrowLeft size={15} /></button>
        <span title={preview.path}>{preview.path}</span>
        <div className="preview-actions">
          {preview.kind === "file" && <>
            <button className="preview-mode-button" onClick={downloadPreview} title="下载到当前设备"><Download size={13} /> 下载</button>
            <button className="preview-icon-button" onClick={() => openBrowserPreview(relativePreviewPath())} title="在新标签页预览"><ExternalLink size={13} /></button>
            <button className="preview-icon-button" onClick={() => void openWithFnos(relativePreviewPath())} title="使用飞牛打开文件"><File size={13} /></button>
            <button className="preview-icon-button" onClick={() => void openWithFnos(relativePreviewPath(), true)} title="在飞牛文件管理器中定位"><FolderOpen size={13} /></button>
            <button className="preview-icon-button" onClick={() => void copyNasPath()} title="复制 NAS 完整路径">{copiedPath ? <Check size={13} /> : <Copy size={13} />}</button>
          </>}
          {preview.kind === "file" && preview.fileKind === "text" && isMarkdown(preview.path) && !preview.previewError && <button className="preview-mode-button" onClick={() => setMarkdownSource((value) => !value)}>{markdownSource ? <Eye size={13} /> : <Code2 size={13} />}{markdownSource ? "预览" : "源码"}</button>}
          <em>{preview.kind === "diff" ? "DIFF" : preview.previewError ? "FILE" : preview.fileKind === "image" ? "IMAGE" : isMarkdown(preview.path) && !markdownSource ? "MD" : "CODE"}</em>
        </div>
      </header>
      {preview.previewError ? <div className="file-preview-unavailable"><File size={28} /><strong>这个文件不能在网页中预览</strong><span>{preview.previewError}</span><div><button className="primary-button compact" onClick={downloadPreview}><Download size={14} /> 仍然下载</button><button className="secondary-button compact" onClick={openContainingFolder}><FolderOpen size={14} /> 所在目录</button></div></div> : preview.kind === "diff" ? <DiffView value={preview.content || "暂无内容"} className="workspace-diff" /> : preview.fileKind === "image" && preview.dataUrl ? <button className="file-image-preview" onClick={() => setExpandedImage(preview.dataUrl!)} title="点击放大图片"><img src={preview.dataUrl} alt={preview.path} /><span><Maximize2 size={15} /> 点击放大</span></button> : isMarkdown(preview.path) && !markdownSource ? <div className="file-markdown markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>{preview.content || "*暂无内容*"}</ReactMarkdown></div> : <pre className="code-source">{preview.content || "暂无内容"}</pre>}
    </div> : <div className="inspector-list">
      {tab === "changes" && <>{changeMessage && <div className="inspector-note">{changeMessage}</div>}{changes.map((change) => <button key={change.path} onClick={() => void openChange(change)}><span className={`change-badge ${change.kind}`}>{change.status?.trim() || change.kind.slice(0, 1).toUpperCase()}</span><span><strong>{change.path}</strong><small>{change.kind === "untracked" ? "未跟踪" : change.kind === "added" ? "新增" : change.kind === "deleted" ? "删除" : "已修改"}</small></span><ChevronRight size={14} /></button>)}{changes.length === 0 && !loading && <div className="inspector-empty">暂时没有检测到文件改动</div>}</>}
      {tab === "files" && <>{directory && <button onClick={() => void loadFiles(parent || "")}><ArrowLeft size={15} /><span><strong>返回上级</strong><small>{directory}</small></span></button>}{entries.map((entry) => <button key={entry.path} onClick={() => void (entry.type === "directory" ? loadFiles(entry.path) : openFile(entry.path))}>{entry.type === "directory" ? <Folder size={16} /> : /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name) ? <ImageIcon size={16} /> : <File size={16} />}<span><strong>{entry.name}</strong><small>{entry.type === "file" && entry.size !== null ? `${Math.max(1, Math.round(entry.size / 1024))} KB` : entry.path}</small></span><ChevronRight size={14} /></button>)}{entries.length === 0 && !loading && <div className="inspector-empty">这个目录是空的</div>}</>}
      {tab === "artifacts" && <>{artifacts.map((artifact) => <button key={artifact.path} onClick={() => openArtifact(artifact)}><PackageOpen size={16} /><span><strong>{artifact.name}</strong><small>{artifact.path} · {Math.max(1, Math.round(artifact.size / 1024))} KB</small></span><ChevronRight size={14} /></button>)}{artifacts.length === 0 && !loading && <div className="inspector-empty">还没有检测到 HTML、PDF、图片、音视频或安装包产物</div>}</>}
    </div>}
    {expandedImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="项目图片预览" onClick={() => setExpandedImage(null)}><button className="image-lightbox-close" onClick={() => setExpandedImage(null)} aria-label="关闭图片预览"><X size={22} /></button><img src={expandedImage} alt="放大的项目图片" onClick={(event) => event.stopPropagation()} /></div>}
  </aside>;
}
