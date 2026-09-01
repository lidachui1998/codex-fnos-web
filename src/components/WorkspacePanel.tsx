import { ArrowLeft, BookOpen, Check, ChevronRight, Code2, Copy, Download, ExternalLink, Eye, File, FileDiff, Folder, FolderOpen, History, Image as ImageIcon, Maximize2, PackageOpen, Pencil, RefreshCw, RotateCcw, Save, Search, Sparkles, X } from "lucide-react";
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
type KnowledgeStatus = { directory: string; enabled: boolean; state: "idle" | "indexing" | "ready" | "error" | "disabled"; lastIndexedAt: number | null; lastScanAt: number | null; fileCount: number; chunkCount: number; bytesIndexed: number; error?: string | null };
type KnowledgeResult = { path: string; startLine: number; endLine: number; snippet: string; score: number; citation: string };
type FileVersion = { id: string; path: string; source: "observed" | "index" | "canvas" | "rollback"; bytes: number; createdAt: number; content?: string };

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

function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeText(value: number | null | undefined) {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "尚未建立";
}

function versionSource(value: FileVersion["source"]) {
  return value === "canvas" ? "画布保存" : value === "rollback" ? "版本回滚" : value === "index" ? "索引发现" : "打开文件";
}

function simpleUnifiedDiff(previous: string, current: string) {
  const before = previous.split("\n");
  const after = current.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const beforeEnd = Math.min(before.length, before.length - suffix + 3);
  const afterEnd = Math.min(after.length, after.length - suffix + 3);
  const removed = before.slice(contextStart, beforeEnd);
  const added = after.slice(contextStart, afterEnd);
  const lines = ["--- 历史版本", "+++ 当前版本", `@@ -${contextStart + 1},${removed.length} +${contextStart + 1},${added.length} @@`];
  const commonHead = Math.min(prefix - contextStart, removed.length, added.length);
  for (let index = 0; index < commonHead; index += 1) lines.push(` ${removed[index]}`);
  const removedMiddleEnd = Math.max(commonHead, removed.length - Math.min(3, suffix));
  const addedMiddleEnd = Math.max(commonHead, added.length - Math.min(3, suffix));
  for (const line of removed.slice(commonHead, removedMiddleEnd)) lines.push(`-${line}`);
  for (const line of added.slice(commonHead, addedMiddleEnd)) lines.push(`+${line}`);
  const tail = added.slice(addedMiddleEnd);
  for (const line of tail) lines.push(` ${line}`);
  return lines.join("\n");
}

export function WorkspacePanel({ project, items, requestedFile, onClose, onContinueWithCodex, onAskKnowledge }: { project: Project; items: ThreadItem[]; requestedFile?: { path: string; nonce: number } | null; onClose: () => void; onContinueWithCodex?: (path: string) => void; onAskKnowledge?: (query: string) => void }) {
  const [tab, setTab] = useState<"changes" | "files" | "artifacts" | "knowledge">("changes");
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
  const [fnosOpening, setFnosOpening] = useState(false);
  const [error, setError] = useState("");
  const [copiedPath, setCopiedPath] = useState(false);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [versionDiff, setVersionDiff] = useState("");
  const [knowledge, setKnowledge] = useState<KnowledgeStatus | null>(null);
  const [knowledgeDirectory, setKnowledgeDirectory] = useState("");
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeResults, setKnowledgeResults] = useState<KnowledgeResult[]>([]);
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
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

  async function loadKnowledge() {
    setKnowledgeBusy(true); setError("");
    try {
      const result = await api<KnowledgeStatus>(`/api/projects/${project.id}/knowledge`);
      setKnowledge(result);
      setKnowledgeDirectory(result.directory || "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识库状态读取失败");
    } finally { setKnowledgeBusy(false); }
  }

  async function saveKnowledgeSettings() {
    setKnowledgeBusy(true); setError(""); setNotice("");
    try {
      const result = await api<KnowledgeStatus>(`/api/projects/${project.id}/knowledge`, {
        method: "PUT",
        body: JSON.stringify({ directory: knowledgeDirectory, enabled: true }),
      });
      setKnowledge(result); setKnowledgeDirectory(result.directory || "");
      setNotice(`知识库已更新：${result.fileCount} 个文件、${result.chunkCount} 个片段`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识库目录保存失败");
    } finally { setKnowledgeBusy(false); }
  }

  async function rebuildKnowledge() {
    setKnowledgeBusy(true); setError(""); setNotice("");
    try {
      const result = await api<KnowledgeStatus>(`/api/projects/${project.id}/knowledge/reindex`, { method: "POST" });
      setKnowledge(result);
      setNotice(`索引完成：${result.fileCount} 个文件、${result.chunkCount} 个片段`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识库重建失败");
    } finally { setKnowledgeBusy(false); }
  }

  async function searchKnowledge() {
    const query = knowledgeQuery.trim();
    if (!query) return;
    setKnowledgeBusy(true); setError("");
    try {
      const result = await api<{ status: KnowledgeStatus; data: KnowledgeResult[] }>(`/api/projects/${project.id}/knowledge/search?query=${encodeURIComponent(query)}&limit=12`);
      setKnowledge(result.status); setKnowledgeResults(result.data ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识库搜索失败");
    } finally { setKnowledgeBusy(false); }
  }

  async function openFile(path: string) {
    setLoading(true); setError("");
    try {
      const result = await api<{ path: string; kind: "text" | "image"; content?: string; mimeType?: string; dataUrl?: string }>(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`);
      setMarkdownSource(false);
      setEditing(false); setDraft(result.content ?? ""); setVersionsOpen(false); setVersions([]); setVersionDiff("");
      setPreview({ path: result.path, content: result.content ?? "", kind: "file", fileKind: result.kind, mimeType: result.mimeType, dataUrl: result.dataUrl });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "文件读取失败";
      setPreview({ path: cleanFileReference(path), content: "", kind: "file", fileKind: "text", previewError: message });
    }
    finally { setLoading(false); }
  }

  async function saveCanvas() {
    if (!preview || preview.kind !== "file" || preview.fileKind !== "text") return;
    setLoading(true); setError(""); setNotice("");
    try {
      const result = await api<{ path: string; content: string; kind: "text"; mimeType: string }>(`/api/projects/${project.id}/file`, {
        method: "PUT",
        body: JSON.stringify({ path: relativePreviewPath(), content: draft }),
      });
      setPreview({ ...preview, path: result.path, content: result.content, mimeType: result.mimeType });
      setDraft(result.content); setEditing(false); setVersionDiff("");
      setNotice("文件已保存，版本历史已记录");
      if (versionsOpen) await loadVersions(result.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文件保存失败");
    } finally { setLoading(false); }
  }

  async function loadVersions(path = relativePreviewPath()) {
    setLoading(true); setError("");
    try {
      const result = await api<{ data: FileVersion[] }>(`/api/projects/${project.id}/file/versions?path=${encodeURIComponent(path)}`);
      setVersions(result.data ?? []); setVersionsOpen(true); setVersionDiff("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "版本历史读取失败");
    } finally { setLoading(false); }
  }

  async function compareVersion(version: FileVersion) {
    if (!preview) return;
    setLoading(true); setError("");
    try {
      const result = await api<FileVersion>(`/api/projects/${project.id}/file/version?path=${encodeURIComponent(relativePreviewPath())}&versionId=${encodeURIComponent(version.id)}`);
      setVersionDiff(simpleUnifiedDiff(result.content || "", editing ? draft : preview.content));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "版本对比失败");
    } finally { setLoading(false); }
  }

  async function rollbackVersion(version: FileVersion) {
    if (!preview) return;
    setLoading(true); setError(""); setNotice("");
    try {
      const result = await api<{ file: { path: string; content: string; kind: "text"; mimeType: string } }>(`/api/projects/${project.id}/file/rollback`, {
        method: "POST",
        body: JSON.stringify({ path: relativePreviewPath(), versionId: version.id }),
      });
      setPreview({ ...preview, path: result.file.path, content: result.file.content, mimeType: result.file.mimeType });
      setDraft(result.file.content); setEditing(false); setVersionDiff("");
      setNotice("已回滚到所选版本，并保留回滚前内容");
      await loadVersions(result.file.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "版本回滚失败");
    } finally { setLoading(false); }
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
    if (/\.(?:md|markdown|html?|txt)$/i.test(artifact.path)) {
      void openFile(artifact.path);
      return;
    }
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
    setFnosOpening(true);
    setError("");
    setNotice(containingFolder ? "正在连接飞牛文件管理器…" : "正在请求飞牛打开文件…");
    try {
      if (containingFolder) {
        const folder = absolutePath.replace(/[\\/][^\\/]+$/, "") || project.path;
        await openFnosFileManager(folder);
        setNotice("打开请求已发送到飞牛文件管理器");
      } else {
        await openFnosFile(absolutePath);
        setNotice("文件打开请求已发送给飞牛");
      }
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "无法调用飞牛文件管理器");
    } finally {
      setFnosOpening(false);
    }
    window.setTimeout(() => setNotice(""), 2_600);
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

  useEffect(() => { setDirectory(""); setPreview(null); setKnowledge(null); setKnowledgeResults([]); void loadChanges(); }, [project.id]);
  useEffect(() => { if (tab === "knowledge") void loadKnowledge(); }, [tab, project.id]);
  useEffect(() => {
    if (tab !== "knowledge" || knowledge?.state !== "indexing") return;
    const timer = window.setInterval(() => void loadKnowledge(), 1_500);
    return () => window.clearInterval(timer);
  }, [tab, project.id, knowledge?.state]);
  useEffect(() => {
    if (!requestedFile) return;
    setTab("files");
    void openFile(requestedFile.path);
  }, [requestedFile?.nonce]);

  return <aside className="workspace-inspector">
    <header><div><Code2 size={17} /><span><strong>项目与产物</strong><small>{project.name}</small></span></div><button className="icon-button small" onClick={onClose} aria-label="关闭项目文件"><X size={17} /></button></header>
    <div className="inspector-tabs"><button className={tab === "changes" ? "active" : ""} onClick={() => { setTab("changes"); void loadChanges(); }}><FileDiff size={14} /> 改动 <em>{changes.length}</em></button><button className={tab === "files" ? "active" : ""} onClick={() => { setTab("files"); void loadFiles(""); }}><Folder size={14} /> 文件</button><button className={tab === "artifacts" ? "active" : ""} onClick={() => { setTab("artifacts"); void loadArtifacts(); }}><PackageOpen size={14} /> 产物 <em>{artifacts.length}</em></button><button className={tab === "knowledge" ? "active" : ""} onClick={() => setTab("knowledge")}><BookOpen size={14} /> 知识</button><button className="icon-button small" onClick={() => void (tab === "changes" ? loadChanges() : tab === "files" ? loadFiles() : tab === "artifacts" ? loadArtifacts() : loadKnowledge())} aria-label="刷新"><RefreshCw size={14} className={loading || knowledgeBusy ? "spin" : ""} /></button></div>
    {error && <div className="inspector-error">{error}</div>}
    {notice && <div className="inspector-note">{notice}</div>}
    {preview ? <div className="code-preview">
      <header>
        <button className="icon-button small" onClick={() => setPreview(null)}><ArrowLeft size={15} /></button>
        <span title={preview.path}>{preview.path}</span>
        <div className="preview-actions">
          {preview.kind === "file" && <>
            {preview.fileKind === "text" && !preview.previewError && (editing
              ? <><button className="preview-mode-button" onClick={() => { setEditing(false); setDraft(preview.content); }}><X size={13} /> 取消</button><button className="preview-mode-button primary" disabled={loading || draft === preview.content} onClick={() => void saveCanvas()}><Save size={13} /> 保存</button></>
              : <button className="preview-mode-button" onClick={() => { setDraft(preview.content); setEditing(true); setMarkdownSource(true); setVersionDiff(""); }}><Pencil size={13} /> 编辑</button>)}
            {preview.fileKind === "text" && !preview.previewError && <button className={`preview-mode-button ${versionsOpen ? "active" : ""}`} onClick={() => versionsOpen ? setVersionsOpen(false) : void loadVersions()}><History size={13} /> 版本</button>}
            {preview.fileKind === "text" && !preview.previewError && <button className="preview-icon-button" onClick={() => { onContinueWithCodex?.(relativePreviewPath()); onClose(); }} title="回到对话并让 Codex 继续修改"><Sparkles size={13} /></button>}
            <button className="preview-mode-button" onClick={downloadPreview} title="下载到当前设备"><Download size={13} /> 下载</button>
            <button className="preview-icon-button" onClick={() => openBrowserPreview(relativePreviewPath())} title="在新标签页预览"><ExternalLink size={13} /></button>
            <button className="preview-icon-button" disabled={fnosOpening} onClick={() => void openWithFnos(relativePreviewPath())} title="使用飞牛打开文件"><File size={13} /></button>
            <button className="preview-icon-button" disabled={fnosOpening} onClick={() => void openWithFnos(relativePreviewPath(), true)} title="在飞牛文件管理器中定位"><FolderOpen size={13} /></button>
            <button className="preview-icon-button" onClick={() => void copyNasPath()} title="复制 NAS 完整路径">{copiedPath ? <Check size={13} /> : <Copy size={13} />}</button>
          </>}
          {preview.kind === "file" && preview.fileKind === "text" && isMarkdown(preview.path) && !preview.previewError && !editing && <button className="preview-mode-button" onClick={() => setMarkdownSource((value) => !value)}>{markdownSource ? <Eye size={13} /> : <Code2 size={13} />}{markdownSource ? "预览" : "源码"}</button>}
          <em>{editing ? "EDIT" : versionDiff ? "COMPARE" : preview.kind === "diff" ? "DIFF" : preview.previewError ? "FILE" : preview.fileKind === "image" ? "IMAGE" : isMarkdown(preview.path) && !markdownSource ? "MD" : "CODE"}</em>
        </div>
      </header>
      {preview.previewError ? <div className="file-preview-unavailable"><File size={28} /><strong>这个文件不能在网页中预览</strong><span>{preview.previewError}</span><div><button className="primary-button compact" onClick={downloadPreview}><Download size={14} /> 仍然下载</button><button className="secondary-button compact" onClick={openContainingFolder}><FolderOpen size={14} /> 所在目录</button></div></div> : editing ? <textarea className="canvas-editor" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label="文件画布编辑器" /> : versionDiff ? <div className="version-diff"><header><strong>历史版本与当前内容对比</strong><button onClick={() => setVersionDiff("")}><X size={13} /> 关闭对比</button></header><DiffView value={versionDiff} className="workspace-diff" /></div> : preview.kind === "diff" ? <DiffView value={preview.content || "暂无内容"} className="workspace-diff" /> : preview.fileKind === "image" && preview.dataUrl ? <button className="file-image-preview" onClick={() => setExpandedImage(preview.dataUrl!)} title="点击放大图片"><img src={preview.dataUrl} alt={preview.path} /><span><Maximize2 size={15} /> 点击放大</span></button> : isMarkdown(preview.path) && !markdownSource ? <div className="file-markdown markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>{preview.content || "*暂无内容*"}</ReactMarkdown></div> : <pre className="code-source">{preview.content || "暂无内容"}</pre>}
      {versionsOpen && preview.fileKind === "text" && <section className="version-drawer"><header><span><History size={14} /><strong>版本历史</strong></span><button onClick={() => setVersionsOpen(false)}><X size={14} /></button></header><div>{versions.map((version, index) => <article key={version.id}><span><strong>{index === 0 ? "当前版本" : timeText(version.createdAt)}</strong><small>{versionSource(version.source)} · {sizeText(version.bytes)}</small></span><button onClick={() => void compareVersion(version)}>对比</button><button disabled={index === 0} onClick={() => void rollbackVersion(version)}><RotateCcw size={12} />回滚</button></article>)}{versions.length === 0 && <p>保存或打开文件后会自动产生版本记录。</p>}</div></section>}
    </div> : <div className={`inspector-list ${tab === "knowledge" ? "knowledge-list" : ""}`}>
      {tab === "changes" && <>{changeMessage && <div className="inspector-note">{changeMessage}</div>}{changes.map((change) => <button key={change.path} onClick={() => void openChange(change)}><span className={`change-badge ${change.kind}`}>{change.status?.trim() || change.kind.slice(0, 1).toUpperCase()}</span><span><strong>{change.path}</strong><small>{change.kind === "untracked" ? "未跟踪" : change.kind === "added" ? "新增" : change.kind === "deleted" ? "删除" : "已修改"}</small></span><ChevronRight size={14} /></button>)}{changes.length === 0 && !loading && <div className="inspector-empty">暂时没有检测到文件改动</div>}</>}
      {tab === "files" && <>{directory && <button onClick={() => void loadFiles(parent || "")}><ArrowLeft size={15} /><span><strong>返回上级</strong><small>{directory}</small></span></button>}{entries.map((entry) => <button key={entry.path} onClick={() => void (entry.type === "directory" ? loadFiles(entry.path) : openFile(entry.path))}>{entry.type === "directory" ? <Folder size={16} /> : /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name) ? <ImageIcon size={16} /> : <File size={16} />}<span><strong>{entry.name}</strong><small>{entry.type === "file" && entry.size !== null ? `${Math.max(1, Math.round(entry.size / 1024))} KB` : entry.path}</small></span><ChevronRight size={14} /></button>)}{entries.length === 0 && !loading && <div className="inspector-empty">这个目录是空的</div>}</>}
      {tab === "artifacts" && <>{artifacts.map((artifact) => <button key={artifact.path} onClick={() => openArtifact(artifact)}><PackageOpen size={16} /><span><strong>{artifact.name}</strong><small>{artifact.path} · {Math.max(1, Math.round(artifact.size / 1024))} KB</small></span><ChevronRight size={14} /></button>)}{artifacts.length === 0 && !loading && <div className="inspector-empty">还没有检测到 Markdown、HTML、PDF、图片、音视频或安装包产物</div>}</>}
      {tab === "knowledge" && <div className="knowledge-panel">
        <section className={`knowledge-status ${knowledge?.state ?? "idle"}`}><header><span><BookOpen size={17} /><strong>项目知识库</strong></span><em>{knowledge?.state === "indexing" ? "索引中" : knowledge?.state === "ready" ? "已就绪" : knowledge?.state === "error" ? "异常" : "准备中"}</em></header><div><span><strong>{knowledge?.fileCount ?? 0}</strong><small>文件</small></span><span><strong>{knowledge?.chunkCount ?? 0}</strong><small>片段</small></span><span><strong>{sizeText(knowledge?.bytesIndexed ?? 0)}</strong><small>本地索引</small></span></div><p>最近索引：{timeText(knowledge?.lastIndexedAt)}。内容只保存在这台 NAS，并会自动增量刷新。</p>{knowledge?.error && <small className="knowledge-error">{knowledge.error}</small>}</section>
        <section className="knowledge-config"><label><span>索引目录（相对项目目录）</span><input value={knowledgeDirectory} onChange={(event) => setKnowledgeDirectory(event.target.value)} placeholder="留空表示整个项目" /></label><div><button disabled={knowledgeBusy} onClick={() => void saveKnowledgeSettings()}><Folder size={13} />保存目录</button><button disabled={knowledgeBusy} onClick={() => void rebuildKnowledge()}><RefreshCw size={13} />完整重建</button></div></section>
        <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); void searchKnowledge(); }}><div><Search size={15} /><input value={knowledgeQuery} onChange={(event) => setKnowledgeQuery(event.target.value)} placeholder="跨文件搜索，例如：登录状态怎么保存？" /><button disabled={knowledgeBusy || !knowledgeQuery.trim()} type="submit">搜索</button></div>{knowledgeQuery.trim() && <button type="button" className="ask-codex" onClick={() => { onAskKnowledge?.(knowledgeQuery.trim()); onClose(); }}><Sparkles size={13} />让 Codex 基于知识库回答</button>}</form>
        <section className="knowledge-results">{knowledgeResults.map((result) => <button key={`${result.path}-${result.startLine}`} onClick={() => void openFile(result.path)}><header><File size={14} /><strong>{result.path}</strong><em>L{result.startLine}–{result.endLine}</em></header><p>{result.snippet}</p><small>匹配度 {Math.round(result.score * 100)}% · {result.citation}</small></button>)}{knowledgeResults.length === 0 && knowledgeQuery.trim() && !knowledgeBusy && <div className="inspector-empty">没有找到相关片段，可以换一种说法或重建索引。</div>}</section>
      </div>}
    </div>}
    {expandedImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="项目图片预览" onClick={() => setExpandedImage(null)}><button className="image-lightbox-close" onClick={() => setExpandedImage(null)} aria-label="关闭图片预览"><X size={22} /></button><img src={expandedImage} alt="放大的项目图片" onClick={(event) => event.stopPropagation()} /></div>}
  </aside>;
}
