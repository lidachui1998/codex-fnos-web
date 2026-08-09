import { ArrowDownToLine, ArrowUpToLine, Bot, Code2, FileText, Folder, FolderMinus, Image, Menu, MessageSquarePlus, PanelLeft, PanelLeftClose, PanelLeftOpen, Paperclip, Plus, Search, Send, Settings, Square, Trash2, Wifi, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api, ApiError, connectEvents } from "./api";
import { createClientId } from "./client-id";
import { ApprovalCard } from "./components/ApprovalCard";
import { LoginScreen } from "./components/LoginScreen";
import { ModelPicker } from "./components/ModelPicker";
import { ProjectDialog } from "./components/ProjectDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Timeline } from "./components/Timeline";
import { WorkspacePanel } from "./components/WorkspacePanel";
import type { AppEvent, Bootstrap, Project, ReasoningEffort, Thread, ThreadItem } from "./types";

function upsertItem(items: ThreadItem[], next: ThreadItem) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
}

function transcript(thread?: Thread | null) {
  return thread?.turns?.flatMap((turn) => turn.items ?? []) ?? [];
}

function threadTitle(thread: Thread) {
  return thread.preview
    ?.replace(/\s*<fnos_attachment name=("[^"]*"|'[^']*')>[\s\S]*?<\/fnos_attachment>/g, "")
    .trim() || "新会话";
}

function threadProviderId(thread?: Thread | null) {
  const value = thread?.modelProvider ?? "";
  return value.startsWith("fnos-") ? value.slice(5) : "";
}

const MODEL_SELECTION_KEY = "codex-fnos-model-selection";
type AuthMode = "checking" | "setup" | "login" | "authenticated";

function selectionKey(projectId: string | null, threadId?: string | null) {
  return `${MODEL_SELECTION_KEY}:${threadId ? `thread:${threadId}` : `project:${projectId || "global"}`}`;
}

function savedModelSelection(projectId: string | null, threadId?: string | null) {
  try {
    return JSON.parse(localStorage.getItem(selectionKey(projectId, threadId)) || "null") as { providerId?: string; model?: string; effort?: ReasoningEffort | "" } | null;
  } catch {
    return null;
  }
}

type ChatAttachment =
  | { id: string; kind: "image"; name: string; size: number; dataUrl: string }
  | { id: string; kind: "text"; name: string; size: number; content: string };

function friendlyTime(seconds: number) {
  const date = new Date(seconds * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export default function App() {
  const [authMode, setAuthMode] = useState<AuthMode>("checking");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [authError, setAuthError] = useState("");
  const [fatalError, setFatalError] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort | "">("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [streamingItemId, setStreamingItemId] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<Array<{ id: number; method: string; params: Record<string, any> }>>([]);
  const [turnRunning, setTurnRunning] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [projectDialog, setProjectDialog] = useState(false);
  const [settingsDialog, setSettingsDialog] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [mobileProjects, setMobileProjects] = useState(false);
  const [mobileThreads, setMobileThreads] = useState(false);
  const [threadSearch, setThreadSearch] = useState("");
  const [threadsCollapsed, setThreadsCollapsed] = useState(() => localStorage.getItem("codex-fnos-threads-collapsed") === "true");
  const [workspacePanel, setWorkspacePanel] = useState(false);
  const [scrollPosition, setScrollPosition] = useState({ atTop: true, atBottom: true });
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const selectedThreadRef = useRef<string | null>(null);
  const selectionProjectRef = useRef<string | null | undefined>(undefined);
  const deltaQueue = useRef(new Map<string, string>());
  const deltaFrame = useRef<number | null>(null);
  const optimisticUserItemId = useRef<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const forceLatestOnOpenRef = useRef(false);

  const selectedProject = bootstrap?.projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const visibleThreads = threads.filter((thread) => threadTitle(thread).toLowerCase().includes(threadSearch.toLowerCase()));
  const eventsEnabled = authMode === "authenticated" && bootstrap !== null;

  useEffect(() => { selectedThreadRef.current = selectedThreadId; }, [selectedThreadId]);

  useEffect(() => {
    const projectId = selectedProject?.id ?? null;
    if (selectionProjectRef.current === projectId) return;
    selectionProjectRef.current = projectId;
    const saved = savedModelSelection(projectId);
    const savedProviderExists = !saved?.providerId || bootstrap?.providers.some((item) => item.id === saved.providerId);
    const providerId = saved && savedProviderExists ? saved.providerId ?? "" : selectedProject?.defaultProviderId ?? "";
    setSelectedProviderId(providerId);
    setSelectedModel(saved && savedProviderExists ? saved.model ?? "" : bootstrap?.providers.find((item) => item.id === providerId)?.model ?? "");
    setSelectedEffort(saved && savedProviderExists ? saved.effort ?? "" : "");
  }, [selectedProject, bootstrap?.providers]);

  async function selectModel(providerId: string, model: string, effort: ReasoningEffort | "") {
    setSelectedProviderId(providerId);
    setSelectedModel(model);
    setSelectedEffort(effort);
    const sameProvider = selectedThread && threadProviderId(selectedThread) === providerId;
    const key = selectionKey(selectedProject?.id || null, sameProvider ? selectedThread.id : null);
    localStorage.setItem(key, JSON.stringify({ providerId, model, effort }));
    if (sameProvider) {
      try {
        await api(`/api/threads/${selectedThread.id}/settings`, {
          method: "PATCH",
          body: JSON.stringify({ model: model || undefined, effort: effort || undefined }),
        });
        setThreads((current) => current.map((thread) => thread.id === selectedThread.id
          ? { ...thread, model, reasoningEffort: effort || null }
          : thread));
      } catch (reason) {
        setFatalError(reason instanceof Error ? `模型切换失败：${reason.message}` : "模型切换失败");
        throw reason;
      }
    }
  }

  useEffect(() => {
    localStorage.setItem("codex-fnos-threads-collapsed", String(threadsCollapsed));
  }, [threadsCollapsed]);

  useEffect(() => {
    document.documentElement.dataset.theme = bootstrap?.settings.theme ?? "system";
  }, [bootstrap?.settings.theme]);

  const loadBootstrap = useCallback(async () => {
    try {
      const next = await api<Bootstrap>("/api/bootstrap");
      setBootstrap(next);
      setAuthError("");
      setFatalError("");
      setSelectedProjectId((current) => current && next.projects.some((item) => item.id === current)
        ? current
        : next.projects[0]?.id ?? null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setBootstrap(null);
        setAuthMode("login");
        setAuthError("登录已失效，请重新输入你设置的访问密码");
      } else {
        setFatalError(reason instanceof Error ? reason.message : "工作台加载失败");
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ authenticated: boolean; setupRequired: boolean }>("/api/auth/status")
      .then((status) => {
        if (cancelled) return;
        setAuthMode(status.authenticated ? "authenticated" : status.setupRequired ? "setup" : "login");
        setAuthError("");
      })
      .catch((reason) => {
        if (cancelled) return;
        setAuthMode("login");
        setAuthError(reason instanceof Error ? reason.message : "无法检查登录状态");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (authMode === "authenticated") void loadBootstrap();
  }, [authMode, loadBootstrap]);

  const flushDeltas = useCallback(() => {
    const queued = new Map(deltaQueue.current);
    deltaQueue.current.clear();
    deltaFrame.current = null;
    if (queued.size === 0) return;
    setItems((current) => {
      let next = current;
      for (const [id, delta] of queued) {
        const existing = next.find((item) => item.id === id);
        next = upsertItem(next, existing
          ? { ...existing, text: `${existing.text ?? ""}${delta}` }
          : { id, type: "agentMessage", text: delta });
      }
      return next;
    });
  }, []);

  const handleEvent = useCallback((raw: unknown) => {
    const event = raw as AppEvent;
    if (event.kind === "bridge_state") {
      setBootstrap((current) => current ? { ...current, bridge: event.state } : current);
      return;
    }
    if (event.kind === "bridge_error") {
      setFatalError(event.message);
      return;
    }
    if (event.kind === "server_request") {
      if (event.request.method === "currentTime/read") {
        void api("/api/rpc/respond", { method: "POST", body: JSON.stringify({ id: event.request.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }) });
        return;
      }
      setPendingRequests((current) => current.some((item) => item.id === event.request.id) ? current : [...current, event.request]);
      return;
    }
    if (event.kind !== "notification") return;
    const params = event.params ?? {};
    if (event.method === "serverRequest/resolved") {
      setPendingRequests((current) => current.filter((item) => item.id !== params.requestId));
      return;
    }
    if (event.method === "account/updated" || event.method === "account/login/completed") {
      void loadBootstrap();
    }
    if (params.threadId && params.threadId !== selectedThreadRef.current) return;
    if (event.method === "turn/started") {
      setTurnRunning(true);
      setActiveTurnId(params.turn?.id ?? null);
      return;
    }
    if (event.method === "item/started" && params.item) {
      if (params.item.type === "userMessage" && optimisticUserItemId.current) {
        const optimisticId = optimisticUserItemId.current;
        optimisticUserItemId.current = null;
        setItems((current) => upsertItem(
          optimisticId === params.item.id ? current : current.filter((item) => item.id !== optimisticId),
          params.item,
        ));
      } else {
        setItems((current) => upsertItem(current, params.item));
      }
      if (params.item.type === "agentMessage") setStreamingItemId(params.item.id);
      return;
    }
    if (event.method === "item/agentMessage/delta") {
      const itemId = String(params.itemId);
      deltaQueue.current.set(itemId, `${deltaQueue.current.get(itemId) ?? ""}${params.delta ?? ""}`);
      setStreamingItemId(itemId);
      if (deltaFrame.current === null) deltaFrame.current = requestAnimationFrame(flushDeltas);
      return;
    }
    if (event.method === "item/reasoning/summaryTextDelta") {
      const itemId = String(params.itemId);
      setItems((current) => {
        const existing = current.find((item) => item.id === itemId);
        return upsertItem(current, { ...(existing ?? { id: itemId, type: "reasoning" }), summary: [`${existing?.summary?.[0] ?? ""}${params.delta ?? ""}`] });
      });
      return;
    }
    if (event.method === "item/completed" && params.item) {
      deltaQueue.current.delete(params.item.id);
      setItems((current) => upsertItem(current, params.item));
      setStreamingItemId((current) => current === params.item.id ? null : current);
      return;
    }
    if (event.method === "turn/completed") {
      setTurnRunning(false);
      setActiveTurnId(null);
      setStreamingItemId(null);
    }
  }, [flushDeltas, loadBootstrap]);

  useEffect(() => {
    if (!eventsEnabled) return;
    const controller = new AbortController();
    let retry: number | undefined;
    const connect = () => connectEvents(handleEvent, controller.signal).catch((reason) => {
      if (reason instanceof ApiError && reason.status === 401) {
        setBootstrap(null);
        setAuthMode("login");
        setAuthError("登录已失效，请重新输入你设置的访问密码");
        return;
      }
      if (!controller.signal.aborted) retry = window.setTimeout(connect, 1500);
    });
    void connect();
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [eventsEnabled, handleEvent]);

  const loadThreads = useCallback(async (project: Project | null) => {
    if (!project || bootstrap?.bridge.status !== "ready") {
      setThreads([]);
      setSelectedThreadId(null);
      setItems([]);
      return;
    }
    try {
      const result = await api<{ data: Thread[] }>(`/api/threads?cwd=${encodeURIComponent(project.path)}`);
      setThreads(result.data ?? []);
      setSelectedThreadId((current) => current && result.data?.some((item) => item.id === current) ? current : null);
      if (!selectedThreadRef.current) setItems([]);
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : "会话列表加载失败");
    }
  }, [bootstrap?.bridge.status]);

  useEffect(() => { void loadThreads(selectedProject); }, [loadThreads, selectedProject]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (forceLatestOnOpenRef.current) {
      forceLatestOnOpenRef.current = false;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
      setScrollPosition({ atTop: false, atBottom: true });
      return;
    }
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distance < 240) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: streamingItemId ? "auto" : "smooth" });
      setScrollPosition({ atTop: false, atBottom: true });
    }
  }, [items, pendingRequests, streamingItemId]);

  function updateScrollPosition() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setScrollPosition({
      atTop: scroller.scrollTop < 12,
      atBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24,
    });
  }

  function jumpConversation(target: "top" | "bottom") {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: target === "top" ? 0 : scroller.scrollHeight, behavior: "smooth" });
  }

  async function openThread(thread: Thread) {
    setSelectedThreadId(thread.id);
    setMobileThreads(false);
    setItems([]);
    setFatalError("");
    try {
      const result = await api<{ thread: Thread; model: string; modelProvider: string; reasoningEffort?: ReasoningEffort | null }>(`/api/threads/${thread.id}/resume`, { method: "POST", body: "{}" });
      const resumedThread = { ...result.thread, model: result.model, modelProvider: result.modelProvider, reasoningEffort: result.reasoningEffort };
      setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, ...resumedThread } : item));
      forceLatestOnOpenRef.current = true;
      setItems(transcript(resumedThread));
      setTurnRunning(typeof resumedThread.status === "object" && resumedThread.status?.type === "active");
      const providerId = threadProviderId(resumedThread);
      const saved = savedModelSelection(selectedProject?.id ?? null, result.thread.id);
      setSelectedProviderId(providerId);
      setSelectedModel(saved?.model || result.model || bootstrap?.providers.find((item) => item.id === providerId)?.model || "");
      setSelectedEffort(saved?.effort ?? result.reasoningEffort ?? "");
      setAttachments([]);
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : "会话恢复失败");
    }
  }

  async function createThread() {
    if (!selectedProject) return null;
    const result = await api<{ thread: Thread }>("/api/threads", {
      method: "POST",
      body: JSON.stringify({ projectId: selectedProject.id, providerId: selectedProviderId || null, model: selectedModel || undefined, effort: selectedEffort || undefined }),
    });
    setThreads((current) => [result.thread, ...current.filter((item) => item.id !== result.thread.id)]);
    setSelectedThreadId(result.thread.id);
    localStorage.setItem(selectionKey(selectedProject.id, result.thread.id), JSON.stringify({ providerId: selectedProviderId, model: selectedModel, effort: selectedEffort }));
    setItems([]);
    setMobileThreads(false);
    return result.thread.id;
  }

  async function sendMessage() {
    const text = composer.trim();
    if ((!text && attachments.length === 0) || sending || turnRunning || !selectedProject) return;
    setSending(true);
    setFatalError("");
    try {
      const providerChanged = selectedThread && threadProviderId(selectedThread) !== selectedProviderId;
      const threadId = !selectedThreadId || providerChanged ? await createThread() : selectedThreadId;
      if (!threadId) return;
      const clientId = createClientId();
      optimisticUserItemId.current = clientId;
      const optimisticContent: NonNullable<ThreadItem["content"]> = [];
      if (text) optimisticContent.push({ type: "text", text });
      for (const attachment of attachments) {
        if (attachment.kind === "image") optimisticContent.push({ type: "image", url: attachment.dataUrl });
        else optimisticContent.push({ type: "text", text: `📎 ${attachment.name}` });
      }
      setItems((current) => [...current, { id: clientId, type: "userMessage", content: optimisticContent }]);
      setThreads((current) => current.map((thread) => thread.id === threadId && !thread.preview?.trim()
        ? { ...thread, preview: text, updatedAt: Math.floor(Date.now() / 1000) }
        : thread));
      setComposer("");
      const sendingAttachments = attachments;
      setAttachments([]);
      setTurnRunning(true);
      const result = await api<{ turn: { id: string } }>(`/api/threads/${threadId}/turns`, {
        method: "POST",
        body: JSON.stringify({ text, clientId, model: selectedModel || undefined, effort: selectedEffort || undefined, attachments: sendingAttachments.map(({ id: _id, size: _size, ...item }) => item) }),
      });
      setActiveTurnId(result.turn.id);
    } catch (reason) {
      setTurnRunning(false);
      optimisticUserItemId.current = null;
      setFatalError(reason instanceof Error ? reason.message : "消息发送失败");
    } finally {
      setSending(false);
    }
  }

  async function addAttachments(files: FileList | File[] | null) {
    if (!files) return;
    const available = Math.max(0, 6 - attachments.length);
    const next: ChatAttachment[] = [];
    try {
      for (const file of Array.from(files).slice(0, available)) {
        const id = createClientId();
        if (file.type.startsWith("image/")) {
          if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) throw new Error(`${file.name} 的图片格式不支持`);
          if (file.size > 6 * 1024 * 1024) throw new Error(`${file.name} 超过 6 MB`);
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error(`${file.name} 读取失败`));
            reader.readAsDataURL(file);
          });
          next.push({ id, kind: "image", name: file.name, size: file.size, dataUrl });
        } else {
          if (file.size > 512 * 1024) throw new Error(`${file.name} 超过 512 KB`);
          const content = await file.text();
          if (content.includes("\0")) throw new Error(`${file.name} 是二进制文件；目前支持图片和文本/代码文件`);
          next.push({ id, kind: "text", name: file.name, size: file.size, content });
        }
      }
      setAttachments((current) => [...current, ...next].slice(0, 6));
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : "附件读取失败");
    } finally {
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  }

  async function interrupt() {
    if (!selectedThreadId || !activeTurnId) return;
    await api(`/api/threads/${selectedThreadId}/interrupt`, { method: "POST", body: JSON.stringify({ turnId: activeTurnId }) });
  }

  async function deleteThread(thread: Thread) {
    if (thread.id === selectedThreadId && turnRunning) {
      setFatalError("当前会话还在运行，请先停止后再删除");
      return;
    }
    if (!window.confirm(`删除会话“${threadTitle(thread)}”？\n\n会话会从历史列表移除，项目目录和代码文件不会被删除。`)) return;
    try {
      await api(`/api/threads/${thread.id}`, { method: "DELETE" });
      localStorage.removeItem(selectionKey(selectedProject?.id ?? null, thread.id));
      setThreads((current) => current.filter((item) => item.id !== thread.id));
      if (thread.id === selectedThreadId) {
        setSelectedThreadId(null);
        setItems([]);
        setPendingRequests([]);
        setAttachments([]);
      }
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : "会话删除失败");
    }
  }

  async function removeProject(project: Project) {
    if (!window.confirm(`从工作台移除“${project.name}”？\n\n只移除项目入口，不会删除 NAS 上的目录和文件。重新添加相同目录后，历史会话仍可找回。`)) return;
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      if (selectedProjectId === project.id) {
        setSelectedProjectId(null); setSelectedThreadId(null); setItems([]); setWorkspacePanel(false);
      }
      await loadBootstrap();
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : "项目移除失败");
    }
  }

  async function authenticate(password: string) {
    setAuthError("");
    try {
      const path = authMode === "setup" ? "/api/auth/setup" : "/api/auth/login";
      await api(path, { method: "POST", body: JSON.stringify({ password }) });
      setAuthMode("authenticated");
      setAuthError("");
      setFatalError("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && authMode === "setup") setAuthMode("login");
      setAuthError(reason instanceof Error ? reason.message : "登录失败");
    }
  }

  if (authMode !== "authenticated" || !bootstrap) {
    return <LoginScreen
      mode={authMode === "authenticated" ? "checking" : authMode}
      error={authError || fatalError}
      onSubmit={authenticate}
      onRetry={() => {
        setFatalError("");
        void loadBootstrap();
      }}
    />;
  }

  const shellStyle = bootstrap.appearance.hasBackground && bootstrap.settings.backgroundEnabled
    ? { "--workspace-background": `url(/api/appearance/background?v=${bootstrap.appearance.updatedAt ?? 0})`, "--background-opacity": bootstrap.settings.backgroundOpacity } as CSSProperties
    : undefined;

  return (
    <div className={`app-shell ${threadsCollapsed ? "threads-collapsed" : ""} ${workspacePanel && selectedProject ? "workspace-open" : ""} ${shellStyle ? "has-background" : ""}`} style={shellStyle}>
      <aside className={`projects-panel ${mobileProjects ? "mobile-open" : ""}`}>
        <header className="brand-header">
          <div className="brand"><div className="brand-mark"><img src="/app-icon.png" alt="" /></div><div><strong>Codex</strong><small>飞牛工作台</small></div></div>
          <button className="icon-button mobile-only" onClick={() => setMobileProjects(false)} aria-label="关闭项目栏"><X size={18} /></button>
        </header>
        <div className="panel-caption"><span>项目</span><button className="icon-button small" onClick={() => setProjectDialog(true)} aria-label="创建项目"><Plus size={16} /></button></div>
        <nav className="project-list">
          {bootstrap.projects.map((project) => (
            <div key={project.id} className={`project-row ${project.id === selectedProjectId ? "active" : ""}`}>
              <button className="project-button" onClick={() => { setSelectedProjectId(project.id); setSelectedThreadId(null); setItems([]); setAttachments([]); setMobileProjects(false); }}>
                <span className="folder-icon"><Folder size={16} /></span><span><strong>{project.name}</strong><small>{project.path}</small></span>
              </button>
              <button className="project-remove" title="从工作台移除（不删除目录）" aria-label={`移除 ${project.name}`} onClick={() => void removeProject(project)}><FolderMinus size={14} /></button>
            </div>
          ))}
          {bootstrap.projects.length === 0 && <button className="create-first" onClick={() => setProjectDialog(true)}><Plus size={18} /><strong>创建第一个项目</strong><span>选择一个 NAS 目录开始</span></button>}
        </nav>
        <footer className="projects-footer">
          <button className="settings-button" onClick={() => setSettingsDialog(true)}><Settings size={17} /><span>设置</span><em className={bootstrap.bridge.status === "ready" ? "online" : "offline"}>{bootstrap.bridge.status === "ready" ? <Wifi size={14} /> : <WifiOff size={14} />}</em></button>
          <div className="version-label">v{bootstrap.version}</div>
        </footer>
      </aside>

      <aside className={`threads-panel ${mobileThreads ? "mobile-open" : ""}`}>
        <header className="threads-header">
          <div><small>当前项目</small><strong>{selectedProject?.name || "选择项目"}</strong></div>
          <div className="header-actions"><button className="icon-button" disabled={!selectedProject || bootstrap.bridge.status !== "ready"} onClick={() => void createThread()} aria-label="新会话"><MessageSquarePlus size={18} /></button><button className="icon-button mobile-only" onClick={() => setMobileThreads(false)} aria-label="关闭会话栏"><X size={18} /></button></div>
        </header>
        <div className="thread-search"><Search size={15} /><input value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} placeholder="搜索会话" /></div>
        <nav className="thread-list">
          {visibleThreads.map((thread) => (
            <div key={thread.id} className={`thread-row ${thread.id === selectedThreadId ? "active" : ""}`}>
              <button className="thread-button" onClick={() => void openThread(thread)}>
                <span className="thread-title">{threadTitle(thread)}</span><span className="thread-meta">{friendlyTime(thread.updatedAt || thread.createdAt)}</span>
              </button>
              <button className="thread-delete" disabled={thread.id === selectedThreadId && turnRunning} title="删除会话" aria-label={`删除会话 ${threadTitle(thread)}`} onClick={() => void deleteThread(thread)}><Trash2 size={13} /></button>
            </div>
          ))}
          {selectedProject && threads.length === 0 && <div className="empty-threads"><MessageSquarePlus size={22} /><span>这个项目还没有会话</span><button onClick={() => void createThread()}>新建会话</button></div>}
        </nav>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div className="mobile-header-buttons"><button className="icon-button" onClick={() => setMobileProjects(true)} aria-label="打开项目栏"><Menu size={19} /></button><button className="icon-button" onClick={() => setMobileThreads(true)} aria-label="打开会话栏"><PanelLeft size={19} /></button></div>
          <button className="icon-button desktop-thread-toggle" onClick={() => setThreadsCollapsed((value) => !value)} title={threadsCollapsed ? "展开会话记录" : "折叠会话记录"} aria-label={threadsCollapsed ? "展开会话记录" : "折叠会话记录"}>{threadsCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
          <div className="conversation-title"><strong>{selectedThread ? threadTitle(selectedThread) : selectedProject?.name || "Codex 工作台"}</strong><span>{selectedProject?.path || "创建或选择一个项目开始"}</span></div>
          <div className="conversation-tools">
            <ModelPicker
              bootstrap={bootstrap}
              open={modelPickerOpen}
              providerId={selectedProviderId}
              model={selectedModel}
              effort={selectedEffort}
              threadProviderId={selectedThread ? threadProviderId(selectedThread) : null}
              onOpenChange={setModelPickerOpen}
              onSelect={selectModel}
              onChanged={loadBootstrap}
              onAdvancedSettings={() => setSettingsDialog(true)}
            />
            <button className={`icon-button ${workspacePanel ? "active-tool" : ""}`} disabled={!selectedProject} title="项目文件和改动" aria-label="项目文件和改动" onClick={() => setWorkspacePanel((value) => !value)}><Code2 size={17} /></button>
            <button className="icon-button header-settings-button" title="设置" aria-label="设置" onClick={() => setSettingsDialog(true)}><Settings size={17} /></button>
            <button className="icon-button danger" disabled={!selectedThread || turnRunning} title="删除当前会话" aria-label="删除当前会话" onClick={() => selectedThread && void deleteThread(selectedThread)}><Trash2 size={17} /></button>
          </div>
        </header>

        <div className="conversation-scroll" ref={scrollerRef} onScroll={updateScrollPosition}>
          {fatalError && <div className="workspace-error"><WifiOff size={16} /> {fatalError}<button onClick={() => { setFatalError(""); void loadBootstrap(); }}>重试</button></div>}
          {!selectedProject ? (
            <div className="welcome-state"><div className="welcome-mark"><Bot size={30} /></div><h1>你的飞牛 Codex 工作台</h1><p>项目、会话和模型配置都留在 NAS 上。先设置 API 令牌和模型，再创建一个项目目录开始工作。</p><div className="welcome-actions"><button className="secondary-button" onClick={() => setModelPickerOpen(true)}>设置令牌与模型</button><button className="primary-button" onClick={() => setProjectDialog(true)}><Plus size={17} /> 创建项目</button></div></div>
          ) : (
            <div className="conversation-inner">
              <Timeline items={items} streamingItemId={streamingItemId} turnRunning={turnRunning} onSuggestion={(text) => setComposer(text)} />
              {pendingRequests.filter((request) => !request.params.threadId || request.params.threadId === selectedThreadId).map((request) => <ApprovalCard key={request.id} request={request} onResolved={(id) => setPendingRequests((current) => current.filter((item) => item.id !== id))} />)}
            </div>
          )}
        </div>
        {selectedProject && items.length > 0 && <div className="scroll-jumps" aria-label="聊天位置跳转">
          <button disabled={scrollPosition.atTop} onClick={() => jumpConversation("top")} title="跳到最顶部"><ArrowUpToLine size={15} /><span>顶部</span></button>
          <button className={!scrollPosition.atBottom ? "has-newer" : ""} disabled={scrollPosition.atBottom} onClick={() => jumpConversation("bottom")} title="跳到最新消息"><ArrowDownToLine size={15} /><span>最新</span></button>
        </div>}

        <footer className="composer-wrap">
          <div className={`composer-box ${turnRunning ? "running" : ""}`}>
            {attachments.length > 0 && <div className="attachment-list">{attachments.map((item) => <div className="attachment-chip" key={item.id}>{item.kind === "image" ? <Image size={14} /> : <FileText size={14} />}<span><strong>{item.name}</strong><small>{Math.max(1, Math.round(item.size / 1024))} KB</small></span><button onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))} aria-label={`移除 ${item.name}`}><X size={13} /></button></div>)}</div>}
            <textarea value={composer} onChange={(event) => setComposer(event.target.value)} onPaste={(event) => { const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (images.length > 0) { event.preventDefault(); void addAttachments(images); } }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={selectedProject ? "告诉 Codex 你想完成什么…" : "请先选择项目"} disabled={!selectedProject || bootstrap.bridge.status !== "ready" || turnRunning} rows={1} />
            <div className="composer-actions"><div className="composer-left"><input ref={attachmentInputRef} className="sr-only" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.jsonl,.js,.jsx,.ts,.tsx,.css,.html,.xml,.yaml,.yml,.toml,.ini,.env,.sh,.py,.java,.go,.rs,.sql,.log,.csv" onChange={(event) => void addAttachments(event.target.files)} /><button className="attach-button" disabled={!selectedProject || turnRunning || attachments.length >= 6} onClick={() => attachmentInputRef.current?.click()} title="添加图片或文本/代码文件"><Paperclip size={15} /> <span>附件</span></button><span>Enter 发送 · Shift+Enter 换行</span></div>{turnRunning ? <button className="stop-button" onClick={() => void interrupt()}><Square size={14} /> 停止</button> : <button className="send-button" onClick={() => void sendMessage()} disabled={(!composer.trim() && attachments.length === 0) || sending || !selectedProject} aria-label="发送消息"><Send size={17} /></button>}</div>
          </div>
          <small className="composer-note">Codex 可能会出错，请在执行重要操作前检查文件变更和命令。</small>
        </footer>
      </main>

      {workspacePanel && selectedProject && <WorkspacePanel project={selectedProject} items={items} onClose={() => setWorkspacePanel(false)} />}

      {(mobileProjects || mobileThreads) && <div className="mobile-scrim" onClick={() => { setMobileProjects(false); setMobileThreads(false); }} />}
      <ProjectDialog open={projectDialog} bootstrap={bootstrap} onClose={() => setProjectDialog(false)} onCreated={loadBootstrap} />
      <SettingsDialog open={settingsDialog} bootstrap={bootstrap} onClose={() => setSettingsDialog(false)} onChanged={loadBootstrap} />
    </div>
  );
}
