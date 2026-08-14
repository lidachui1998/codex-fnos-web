import { Archive, ArrowDownToLine, ArrowUpToLine, Bell, Bot, Boxes, CalendarClock, Clock3, Code2, CornerDownRight, FileText, Folder, FolderMinus, Image, Menu, MessageSquarePlus, MoreHorizontal, PanelLeft, PanelLeftClose, PanelLeftOpen, Paperclip, Plus, Search, Send, Settings, ShieldCheck, Sparkles, Square, Trash2, Wifi, WifiOff, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent } from "react";
import { api, ApiError, connectEvents } from "./api";
import { createClientId } from "./client-id";
import { ApprovalCard } from "./components/ApprovalCard";
import { LoginScreen } from "./components/LoginScreen";
import { ModelPicker } from "./components/ModelPicker";
import { findSkillMention, matchingPlugins, matchingSkills, SkillMentionMenu, type ProjectFileMention, type SkillMention } from "./components/SkillMentionMenu";
import { Timeline } from "./components/Timeline";
import { ThreadMenu } from "./components/ThreadMenu";
import type { AppEvent, ApprovalPolicy, Bootstrap, NotificationSummary, PluginSummary, PluginsResult, Project, ReasoningEffort, Skill, SkillsResult, Thread, ThreadItem, Turn } from "./types";

const GlobalSearchDialog = lazy(() => import("./components/GlobalSearchDialog").then((module) => ({ default: module.GlobalSearchDialog })));
const NotificationCenterDialog = lazy(() => import("./components/NotificationCenterDialog").then((module) => ({ default: module.NotificationCenterDialog })));
const PluginsDialog = lazy(() => import("./components/PluginsDialog").then((module) => ({ default: module.PluginsDialog })));
const ProjectDialog = lazy(() => import("./components/ProjectDialog").then((module) => ({ default: module.ProjectDialog })));
const ScheduledTasksDialog = lazy(() => import("./components/ScheduledTasksDialog").then((module) => ({ default: module.ScheduledTasksDialog })));
const SettingsDialog = lazy(() => import("./components/SettingsDialog").then((module) => ({ default: module.SettingsDialog })));
const SkillsDialog = lazy(() => import("./components/SkillsDialog").then((module) => ({ default: module.SkillsDialog })));
const WorkspacePanel = lazy(() => import("./components/WorkspacePanel").then((module) => ({ default: module.WorkspacePanel })));

function upsertItem(items: ThreadItem[], next: ThreadItem) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
}

function turnTiming(turn: Turn) {
  return {
    turnStartedAt: turn.startedAt ?? null,
    turnCompletedAt: turn.completedAt ?? null,
    turnDurationMs: turn.durationMs ?? null,
  };
}

function attachTurnTiming(items: ThreadItem[], turn: Turn) {
  let responseIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].type === "agentMessage" || items[index].type === "plan") {
      responseIndex = index;
      break;
    }
  }
  if (responseIndex < 0) return items;
  return items.map((item, index) => index === responseIndex ? { ...item, ...turnTiming(turn) } : item);
}

function transcript(thread?: Thread | null) {
  return thread?.turns?.flatMap((turn) => {
    let items: ThreadItem[] = (turn.items ?? []).map((item) => ({ ...item, turnId: turn.id }));
    const hasAgentReply = items.some((item) => (item.type === "agentMessage" || item.type === "plan") && item.text?.trim());
    if (turn.status === "failed") items.push(turnErrorItem(turn.id, turn.error, false, false, turn));
    else if (turn.status === "completed" && !hasAgentReply && items.some((item) => item.type === "userMessage")) items.push(turnErrorItem(turn.id, null, true, false, turn));
    else items = attachTurnTiming(items, turn);
    return items;
  }) ?? [];
}

function turnErrorMessage(error: unknown, empty = false) {
  if (empty) return "模型完成了请求，但没有返回可显示的文字。你可以重试，或切换模型后重新发送。";
  if (typeof error === "string") return error.slice(0, 4000);
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; additionalDetails?: unknown; codexErrorInfo?: unknown };
    const message = [value.message, value.additionalDetails, typeof value.codexErrorInfo === "string" ? `错误类型：${value.codexErrorInfo}` : ""]
      .filter((item) => typeof item === "string" && item.trim())
      .join("\n\n") || "模型请求失败，但上游没有提供详细原因。";
    return message.slice(0, 4000);
  }
  return "模型请求失败，但上游没有提供详细原因。";
}

function turnErrorItem(turnId: string, error: unknown, empty = false, retrying = false, turn?: Turn): ThreadItem {
  return { id: `turn-error:${turnId}`, turnId, type: "turnError", text: turnErrorMessage(error, empty), error, retrying, status: retrying ? "inProgress" : "failed", ...(turn ? turnTiming(turn) : {}) };
}

function threadTitle(thread: Thread) {
  if (thread.name?.trim()) return thread.name.trim();
  const value = thread.preview
    ?.replace(/\s*<fnos_attachment name=("[^"]*"|'[^']*')>[\s\S]*?<\/fnos_attachment>/g, "")
    .trim() || "";
  const skillNames = [...value.matchAll(/(?:^|\s)\$([\w:-]+)/g)].map((match) => match[1]);
  const title = value.replace(/^(?:\$[\w:-]+\s*)+/, "").trim();
  return title || (skillNames.length > 0 ? `使用 ${skillNames.join("、")}` : "新会话");
}

function threadProviderId(thread?: Thread | null) {
  const value = thread?.modelProvider ?? "";
  return value.startsWith("fnos-") ? value.slice(5) : "";
}

function normalizeThreadPath(value?: string | null) {
  return String(value || "")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

const MODEL_SELECTION_KEY = "codex-fnos-model-selection";
type AuthMode = "checking" | "setup" | "login" | "authenticated";

type ConversationCacheEntry = {
  items: ThreadItem[];
  scrollTop: number;
  composer: string;
  attachments: ChatAttachment[];
  selectedSkills: Skill[];
};

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

type OutgoingMessage = {
  text: string;
  attachments: ChatAttachment[];
  skills: Skill[];
  fromQueue?: boolean;
};

type QueuedMessage = OutgoingMessage & { id: string; threadId: string };

function optimisticMessageContent(payload: OutgoingMessage, text: string): NonNullable<ThreadItem["content"]> {
  const content: NonNullable<ThreadItem["content"]> = [];
  if (text) content.push({ type: "text", text });
  else if (payload.skills.length > 0) content.push({ type: "text", text: `使用 Skills：${payload.skills.map((skill) => skill.name).join("、")}` });
  for (const attachment of payload.attachments) {
    if (attachment.kind === "image") content.push({ type: "image", url: attachment.dataUrl });
    else content.push({ type: "text", text: `📎 ${attachment.name}` });
  }
  return content;
}

function friendlyTime(seconds: number) {
  const date = new Date(seconds * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function outgoingFromItem(item: ThreadItem, skills: Skill[]): OutgoingMessage {
  const textParts = item.content?.filter((part) => part.type === "text").map((part) => part.text ?? "") ?? [];
  const joined = textParts.join("\n");
  const skillNames = [...joined.matchAll(/(?:^|\s)\$([\w:-]+)/g)].map((match) => match[1]);
  const attachments: ChatAttachment[] = [];
  for (const value of textParts) {
    for (const match of value.matchAll(/<fnos_attachment name=("([^"]*)"|'([^']*)')>\n?([\s\S]*?)\n?<\/fnos_attachment>/g)) {
      const content = match[4] ?? "";
      attachments.push({ id: createClientId(), kind: "text", name: match[2] || match[3] || "附件.txt", size: new TextEncoder().encode(content).length, content });
    }
  }
  for (const [index, part] of (item.content ?? []).filter((entry) => entry.type === "image" && entry.url?.startsWith("data:image/")).entries()) {
    const dataUrl = part.url as string;
    const extension = dataUrl.match(/^data:image\/(png|jpeg|webp|gif)/i)?.[1]?.replace("jpeg", "jpg") || "png";
    attachments.push({ id: createClientId(), kind: "image", name: `图片-${index + 1}.${extension}`, size: Math.floor((dataUrl.length * 3) / 4), dataUrl });
  }
  return {
    text: joined
      .replace(/\s*<fnos_attachment name=("[^"]*"|'[^']*')>[\s\S]*?<\/fnos_attachment>/g, "")
      .replace(/^(?:\$[\w:-]+\s*)+/, "")
      .trim(),
    attachments,
    skills: skillNames.map((name) => skills.find((skill) => skill.name === name)).filter((skill): skill is Skill => Boolean(skill)),
  };
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
  const [selectedApprovalPolicy, setSelectedApprovalPolicy] = useState<ApprovalPolicy>("on-request");
  const [selectedNetworkAccess, setSelectedNetworkAccess] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<Skill[]>([]);
  const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const [availablePlugins, setAvailablePlugins] = useState<PluginSummary[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState("");
  const [skillMention, setSkillMention] = useState<SkillMention | null>(null);
  const [skillMentionIndex, setSkillMentionIndex] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<ProjectFileMention[]>([]);
  const [mentionFilesLoading, setMentionFilesLoading] = useState(false);
  const [mentionFilesError, setMentionFilesError] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [streamingItemId, setStreamingItemId] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<Array<{ id: number; method: string; params: Record<string, any> }>>([]);
  const [turnRunning, setTurnRunning] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [activeTurnStartedAtMs, setActiveTurnStartedAtMs] = useState<number | null>(null);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [projectDialog, setProjectDialog] = useState(false);
  const [settingsDialog, setSettingsDialog] = useState(false);
  const [skillsDialog, setSkillsDialog] = useState(false);
  const [pluginsDialog, setPluginsDialog] = useState(false);
  const [scheduledTasksDialog, setScheduledTasksDialog] = useState(false);
  const [notificationDialog, setNotificationDialog] = useState(false);
  const [notificationRevision, setNotificationRevision] = useState(0);
  const [notificationSummary, setNotificationSummary] = useState<NotificationSummary>({ unread: 0, running: 0, failed: 0, scheduled: 0 });
  const [skillsRevision, setSkillsRevision] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [mobileProjects, setMobileProjects] = useState(false);
  const [mobileThreads, setMobileThreads] = useState(false);
  const [threadSearch, setThreadSearch] = useState("");
  const [threadsCollapsed, setThreadsCollapsed] = useState(() => localStorage.getItem("codex-fnos-threads-collapsed") === "true");
  const [workspacePanel, setWorkspacePanel] = useState(false);
  const [workspaceFileRequest, setWorkspaceFileRequest] = useState<{ path: string; nonce: number } | null>(null);
  const [scrollPosition, setScrollPosition] = useState({ atTop: true, atBottom: true });
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const selectedThreadRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const sendingOperationRef = useRef(0);
  const turnRunningRef = useRef(false);
  const activeTurnIdRef = useRef<string | null>(null);
  const activeTurnStartedAtRef = useRef<number | null>(null);
  const selectionProjectRef = useRef<string | null | undefined>(undefined);
  const deltaQueue = useRef(new Map<string, string>());
  const deltaFrame = useRef<number | null>(null);
  const optimisticUserItemId = useRef<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const forceLatestRef = useRef(false);
  const openThreadRequestRef = useRef(0);
  const threadListRequestRef = useRef(0);
  const openThreadAbortRef = useRef<AbortController | null>(null);
  const conversationCacheRef = useRef(new Map<string, ConversationCacheEntry>());
  const prefetchingThreadsRef = useRef(new Set<string>());
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const itemsRef = useRef<ThreadItem[]>([]);
  const composerValueRef = useRef("");
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const selectedSkillsRef = useRef<Skill[]>([]);
  const pluginsLoadedRef = useRef(false);

  const selectedProject = bootstrap?.projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const visibleThreads = threads.filter((thread) => threadTitle(thread).toLowerCase().includes(threadSearch.toLowerCase()));
  const currentQueuedMessages = queuedMessages.filter((item) => item.threadId === selectedThreadId);
  const canSteer = turnRunning && Boolean(activeTurnId) && !sending;
  const retryProviders = useMemo(() => {
    if (!bootstrap) return [];
    const runtimeModelProvider = selectedThread?.runtimeModelProvider ?? selectedThread?.modelProvider ?? "";
    if (selectedThread && !runtimeModelProvider.startsWith("fnos-")) {
      return [{ id: "", name: "OpenAI / ChatGPT", model: selectedProviderId === "" ? selectedModel || selectedThread.model || "默认模型" : selectedThread.model || "默认模型" }];
    }
    return bootstrap.providers
      .filter((provider) => provider.enabled)
      .map((provider) => ({ id: provider.id, name: provider.name, model: provider.id === selectedProviderId ? selectedModel || provider.model : provider.model }));
  }, [bootstrap, selectedModel, selectedProviderId, selectedThread]);
  const retryProviderId = retryProviders.some((provider) => provider.id === selectedProviderId)
    ? selectedProviderId
    : selectedThread ? threadProviderId(selectedThread) : retryProviders[0]?.id ?? "";
  const eventsEnabled = authMode === "authenticated" && bootstrap !== null;
  const mentionSkills = useMemo(
    () => matchingSkills(availableSkills, skillMention?.query ?? "", selectedSkills),
    [availableSkills, selectedSkills, skillMention?.query],
  );
  const mentionPlugins = useMemo(
    () => matchingPlugins(availablePlugins, skillMention?.query ?? ""),
    [availablePlugins, skillMention?.query],
  );
  const selectableMentionSkills = selectedSkills.length >= 6 ? [] : mentionSkills;
  const selectableMentionFiles = attachments.length >= 6 ? mentionFiles.filter((file) => file.type === "directory") : mentionFiles;
  const mentionOptionCount = selectableMentionSkills.length + mentionPlugins.length + selectableMentionFiles.length;

  useEffect(() => {
    if (!skillMention || pluginsLoadedRef.current || bootstrap?.bridge.status !== "ready") return;
    let cancelled = false;
    setPluginsLoading(true);
    setPluginsError("");
    api<PluginsResult>("/api/plugins")
      .then((result) => {
        if (cancelled) return;
        setAvailablePlugins(result.data ?? []);
        pluginsLoadedRef.current = true;
      })
      .catch((reason) => {
        if (!cancelled) setPluginsError(reason instanceof Error ? reason.message : "插件读取失败");
      })
      .finally(() => { if (!cancelled) setPluginsLoading(false); });
    return () => { cancelled = true; };
  }, [bootstrap?.bridge.status, Boolean(skillMention)]);

  useEffect(() => {
    if (!skillMention || !selectedProject) {
      setMentionFiles([]);
      setMentionFilesLoading(false);
      setMentionFilesError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setMentionFilesLoading(true);
      setMentionFilesError("");
      api<{ data: ProjectFileMention[] }>(`/api/projects/${selectedProject.id}/files/search?query=${encodeURIComponent(skillMention.query)}&limit=8`, { signal: controller.signal })
        .then((result) => {
          const attachedNames = new Set(attachments.map((item) => item.name));
          setMentionFiles((result.data ?? []).filter((file) => !attachedNames.has(file.path)));
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setMentionFilesError(reason instanceof Error ? reason.message : "项目文件搜索失败");
        })
        .finally(() => { if (!controller.signal.aborted) setMentionFilesLoading(false); });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [attachments, selectedProject?.id, skillMention?.query]);

  useEffect(() => { selectedThreadRef.current = selectedThreadId; }, [selectedThreadId]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { composerValueRef.current = composer; }, [composer]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => { selectedSkillsRef.current = selectedSkills; }, [selectedSkills]);
  useEffect(() => {
    if (!selectedThreadId) return;
    const previous = conversationCacheRef.current.get(selectedThreadId);
    conversationCacheRef.current.set(selectedThreadId, {
      items,
      scrollTop: previous?.scrollTop ?? 0,
      composer,
      attachments,
      selectedSkills,
    });
  }, [attachments, composer, items, selectedSkills, selectedThreadId]);

  function rememberConversation(threadId = selectedThreadRef.current) {
    if (!threadId) return;
    conversationCacheRef.current.set(threadId, {
      items: itemsRef.current,
      scrollTop: scrollerRef.current?.scrollTop ?? conversationCacheRef.current.get(threadId)?.scrollTop ?? 0,
      composer: composerValueRef.current,
      attachments: attachmentsRef.current,
      selectedSkills: selectedSkillsRef.current,
    });
  }

  function discardPendingDeltas() {
    deltaQueue.current.clear();
    if (deltaFrame.current !== null) cancelAnimationFrame(deltaFrame.current);
    deltaFrame.current = null;
    setStreamingItemId(null);
  }

  function resetCurrentTurnState() {
    sendingOperationRef.current += 1;
    sendingRef.current = false;
    turnRunningRef.current = false;
    activeTurnIdRef.current = null;
    activeTurnStartedAtRef.current = null;
    setSending(false);
    setTurnRunning(false);
    setActiveTurnId(null);
    setActiveTurnStartedAtMs(null);
    setStreamingItemId(null);
  }

  useEffect(() => {
    resetCurrentTurnState();
    setSelectedApprovalPolicy(bootstrap?.settings.approvalPolicy ?? "on-request");
    setSelectedNetworkAccess(bootstrap?.settings.networkAccess ?? true);
    setSelectedSkills([]);
    setSkillMention(null);
    setWorkspaceFileRequest(null);
  }, [selectedProjectId]);

  useEffect(() => {
    resetCurrentTurnState();
    openThreadAbortRef.current?.abort();
    openThreadRequestRef.current += 1;
    threadListRequestRef.current += 1;
    conversationCacheRef.current.clear();
    prefetchingThreadsRef.current.clear();
    setThreadLoading(false);
    selectedThreadRef.current = null;
    setSelectedThreadId(null);
    setThreads([]);
    setItems([]);
    setQueuedMessages([]);
    discardPendingDeltas();
  }, [bootstrap?.activeAccountId]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedProject || bootstrap?.bridge.status !== "ready") {
      setAvailableSkills([]);
      setSkillsError("");
      return;
    }
    setSkillsLoading(true);
    setSkillsError("");
    api<SkillsResult>(`/api/projects/${selectedProject.id}/skills${skillsRevision > 0 ? "?reload=1" : ""}`)
      .then((result) => {
        if (cancelled) return;
        const enabled = result.skills.filter((skill) => skill.enabled);
        const enabledPaths = new Set(enabled.map((skill) => skill.path));
        setAvailableSkills(enabled);
        setSelectedSkills((current) => current.filter((skill) => enabledPaths.has(skill.path)));
      })
      .catch((reason) => {
        if (!cancelled) setSkillsError(reason instanceof Error ? reason.message : "Skills 读取失败");
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => { cancelled = true; };
  }, [bootstrap?.bridge.status, selectedProject?.id, skillsRevision]);

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

  async function selectApprovalPolicy(policy: ApprovalPolicy) {
    const previous = selectedApprovalPolicy;
    setSelectedApprovalPolicy(policy);
    if (!selectedThread) return;
    try {
      await api(`/api/threads/${selectedThread.id}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ approvalPolicy: policy }),
      });
      setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? { ...thread, approvalPolicy: policy } : thread));
    } catch (reason) {
      setSelectedApprovalPolicy(previous);
      setFatalError(reason instanceof Error ? `审批策略切换失败：${reason.message}` : "审批策略切换失败");
    }
  }

  async function selectNetworkAccess(networkAccess: boolean) {
    const previous = selectedNetworkAccess;
    setSelectedNetworkAccess(networkAccess);
    if (!selectedThread) return;
    try {
      await api(`/api/threads/${selectedThread.id}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ networkAccess }),
      });
      setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? { ...thread, networkAccess } : thread));
    } catch (reason) {
      setSelectedNetworkAccess(previous);
      setFatalError(reason instanceof Error ? `联网权限切换失败：${reason.message}` : "联网权限切换失败");
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
      setNotificationSummary(next.notificationSummary);
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
      if (event.state.status === "ready") void loadBootstrap();
      return;
    }
    if (event.kind === "bridge_error") {
      setFatalError(event.message);
      return;
    }
    if (event.kind === "notification_changed") {
      setNotificationSummary(event.summary);
      setNotificationRevision((current) => current + 1);
      return;
    }
    if (event.kind === "thread_created") {
      if (event.projectId === selectedProjectId) {
        setThreads((current) => [event.thread, ...current.filter((thread) => thread.id !== event.thread.id)]);
      }
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
    if (event.method === "skills/changed") {
      setSkillsRevision((current) => current + 1);
      return;
    }
    if (event.method === "serverRequest/resolved") {
      setPendingRequests((current) => current.filter((item) => item.id !== params.requestId));
      return;
    }
    if (event.method === "account/updated" || event.method === "account/login/completed" || event.method === "account/rateLimits/updated") {
      void loadBootstrap();
    }
    if (params.threadId && params.threadId !== selectedThreadRef.current) return;
    if (event.method === "error") {
      const turnId = activeTurnIdRef.current || `current-${params.threadId || "thread"}`;
      setItems((current) => upsertItem(current, turnErrorItem(turnId, params.error, false, Boolean(params.willRetry))));
      return;
    }
    if (event.method === "turn/started") {
      const startedAtMs = Number.isFinite(params.turn?.startedAt) ? Number(params.turn.startedAt) * 1000 : Date.now();
      turnRunningRef.current = true;
      setTurnRunning(true);
      setActiveTurnId(params.turn?.id ?? null);
      activeTurnIdRef.current = params.turn?.id ?? null;
      activeTurnStartedAtRef.current = startedAtMs;
      setActiveTurnStartedAtMs(startedAtMs);
      return;
    }
    if (event.method === "item/started" && params.item) {
      const eventItem = { ...params.item, turnId: params.turnId ?? params.turn?.id };
      if (params.item.type === "userMessage" && optimisticUserItemId.current) {
        const optimisticId = optimisticUserItemId.current;
        optimisticUserItemId.current = null;
        setItems((current) => upsertItem(
          optimisticId === params.item.id ? current : current.filter((item) => item.id !== optimisticId),
          eventItem,
        ));
      } else {
        setItems((current) => upsertItem(current, eventItem));
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
      setItems((current) => {
        const existing = current.find((item) => item.id === params.item.id);
        return upsertItem(current, { ...params.item, turnId: params.turnId ?? params.turn?.id ?? existing?.turnId });
      });
      setStreamingItemId((current) => current === params.item.id ? null : current);
      return;
    }
    if (event.method === "turn/completed") {
      const turn = params.turn ?? {};
      const turnId = String(turn.id || activeTurnIdRef.current || "completed");
      const completedAtMs = Number.isFinite(turn.completedAt) ? Number(turn.completedAt) * 1000 : Date.now();
      const startedAtMs = Number.isFinite(turn.startedAt) ? Number(turn.startedAt) * 1000 : activeTurnStartedAtRef.current;
      const completedTurn: Turn = {
        id: turnId,
        items: Array.isArray(turn.items) ? turn.items : [],
        status: String(turn.status || "completed"),
        error: turn.error ?? null,
        startedAt: startedAtMs === null ? null : Math.floor(startedAtMs / 1000),
        completedAt: Math.floor(completedAtMs / 1000),
        durationMs: Number.isFinite(turn.durationMs) ? Number(turn.durationMs) : startedAtMs === null ? null : Math.max(0, completedAtMs - startedAtMs),
      };
      setItems((current) => {
        let next = current.filter((item) => item.id !== `turn-error:${turnId}`);
        for (const item of Array.isArray(turn.items) ? turn.items : []) next = upsertItem(next, { ...item, turnId });
        const hasReply = next.some((item) => item.turnId === turnId && (item.type === "agentMessage" || item.type === "plan") && item.text?.trim());
        if (turn.status === "failed") return upsertItem(next, turnErrorItem(turnId, turn.error, false, false, completedTurn));
        if (turn.status === "completed" && !hasReply) return upsertItem(next, turnErrorItem(turnId, null, true, false, completedTurn));
        const turnItems = next.filter((item) => item.turnId === turnId);
        const timedTurnItems = attachTurnTiming(turnItems, completedTurn);
        const timedById = new Map(timedTurnItems.map((item) => [item.id, item]));
        return next.map((item) => timedById.get(item.id) ?? item);
      });
      turnRunningRef.current = false;
      setTurnRunning(false);
      setActiveTurnId(null);
      activeTurnIdRef.current = null;
      activeTurnStartedAtRef.current = null;
      setActiveTurnStartedAtMs(null);
      setStreamingItemId(null);
    }
  }, [flushDeltas, loadBootstrap, selectedProjectId]);

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
    const requestId = ++threadListRequestRef.current;
    if (!project) {
      setThreads([]);
      setSelectedThreadId(null);
      selectedThreadRef.current = null;
      setItems([]);
      return;
    }
    if (bootstrap?.bridge.status !== "ready") return;
    try {
      const result = await api<{ data: Thread[] }>(`/api/threads?cwd=${encodeURIComponent(project.path)}${showArchived ? "&archived=1" : ""}`);
      if (requestId !== threadListRequestRef.current) return;
      setThreads((current) => {
        const next = result.data ?? [];
        const selectedId = selectedThreadRef.current;
        const selected = selectedId ? current.find((item) => item.id === selectedId) : null;
        return selected && !next.some((item) => item.id === selected.id) ? [selected, ...next] : next;
      });
    } catch (reason) {
      if (requestId !== threadListRequestRef.current) return;
      setFatalError(reason instanceof Error ? reason.message : "会话列表加载失败");
    }
  }, [bootstrap?.bridge.status, showArchived]);

  useEffect(() => { void loadThreads(selectedProject); }, [loadThreads, selectedProject]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (pendingScrollRestoreRef.current !== null) {
      const scrollTop = pendingScrollRestoreRef.current;
      pendingScrollRestoreRef.current = null;
      scroller.scrollTo({ top: scrollTop, behavior: "auto" });
      updateScrollPosition();
      return;
    }
    if (forceLatestRef.current) {
      forceLatestRef.current = false;
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
    if (selectedThreadRef.current) {
      const previous = conversationCacheRef.current.get(selectedThreadRef.current);
      if (previous) conversationCacheRef.current.set(selectedThreadRef.current, { ...previous, scrollTop: scroller.scrollTop });
    }
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

  function scrollConversationAfterSend() {
    forceLatestRef.current = true;
    window.requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
      setScrollPosition({ atTop: false, atBottom: true });
    });
  }

  function openWorkspaceFile(path: string) {
    setWorkspaceFileRequest({ path, nonce: Date.now() });
    setWorkspacePanel(true);
  }

  function updateSkillMention(value: string, cursor: number) {
    const next = findSkillMention(value, cursor);
    setSkillMentionIndex((current) => next?.query === skillMention?.query ? current : 0);
    setSkillMention(next);
  }

  function handleComposerChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.currentTarget.value;
    setComposer(value);
    updateSkillMention(value, event.currentTarget.selectionStart);
  }

  function selectMentionSkill(skill: Skill) {
    if (!skillMention || selectedSkills.length >= 6) return;
    const nextComposer = `${composer.slice(0, skillMention.start)}${composer.slice(skillMention.end)}`;
    const nextCursor = skillMention.start;
    setComposer(nextComposer);
    setSelectedSkills((current) => current.some((item) => item.path === skill.path) ? current : [...current, skill]);
    setSkillMention(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function selectMentionPlugin(plugin: PluginSummary) {
    if (!skillMention) return;
    const name = plugin.interface?.displayName || plugin.name;
    const token = `@插件[${name}] `;
    const nextComposer = `${composer.slice(0, skillMention.start)}${token}${composer.slice(skillMention.end)}`;
    const nextCursor = skillMention.start + token.length;
    setComposer(nextComposer);
    setSkillMention(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  async function selectMentionFile(file: ProjectFileMention) {
    if (!skillMention || !selectedProject || (file.type === "file" && attachments.length >= 6)) return;
    if (file.type === "directory") {
      const token = `@目录[${file.path}] `;
      const nextComposer = `${composer.slice(0, skillMention.start)}${token}${composer.slice(skillMention.end)}`;
      const nextCursor = skillMention.start + token.length;
      setComposer(nextComposer);
      setSkillMention(null);
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.setSelectionRange(nextCursor, nextCursor);
      });
      return;
    }
    const nextComposer = `${composer.slice(0, skillMention.start)}${composer.slice(skillMention.end)}`;
    const nextCursor = skillMention.start;
    setComposer(nextComposer);
    setSkillMention(null);
    try {
      const result = await api<{
        path: string;
        size: number;
        kind: "text" | "image";
        content?: string;
        dataUrl?: string;
      }>(`/api/projects/${selectedProject.id}/file?path=${encodeURIComponent(file.path)}`);
      if (result.kind === "image") {
        if (result.size > 6 * 1024 * 1024 || !result.dataUrl) throw new Error("图片超过 6 MB，不能作为聊天附件发送");
        const attachment: ChatAttachment = { id: createClientId(), kind: "image", name: result.path, size: result.size, dataUrl: result.dataUrl };
        setAttachments((current) => current.some((item) => item.name === result.path)
          ? current
          : [...current, attachment].slice(0, 6));
      } else {
        if (result.size > 512 * 1024 || result.content === undefined) throw new Error("文本文件超过 512 KB，不能作为聊天附件发送");
        const attachment: ChatAttachment = { id: createClientId(), kind: "text", name: result.path, size: result.size, content: result.content };
        setAttachments((current) => current.some((item) => item.name === result.path)
          ? current
          : [...current, attachment].slice(0, 6));
      }
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.setSelectionRange(nextCursor, nextCursor);
      });
    } catch (reason) {
      setFatalError(reason instanceof Error ? `无法附加 ${file.path}：${reason.message}` : `无法附加 ${file.path}`);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (skillMention) {
      if (event.key === "ArrowDown" && mentionOptionCount > 0) {
        event.preventDefault();
        setSkillMentionIndex((current) => (current + 1) % mentionOptionCount);
        return;
      }
      if (event.key === "ArrowUp" && mentionOptionCount > 0) {
        event.preventDefault();
        setSkillMentionIndex((current) => (current - 1 + mentionOptionCount) % mentionOptionCount);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSkillMention(null);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && skillMentionIndex < selectableMentionSkills.length) {
        event.preventDefault();
        selectMentionSkill(selectableMentionSkills[skillMentionIndex]);
        return;
      }
      const selectedPlugin = mentionPlugins[skillMentionIndex - selectableMentionSkills.length];
      if ((event.key === "Enter" || event.key === "Tab") && selectedPlugin) {
        event.preventDefault();
        selectMentionPlugin(selectedPlugin);
        return;
      }
      const selectedFile = selectableMentionFiles[skillMentionIndex - selectableMentionSkills.length - mentionPlugins.length];
      if ((event.key === "Enter" || event.key === "Tab") && selectedFile) {
        event.preventDefault();
        void selectMentionFile(selectedFile);
        return;
      }
      if (event.key === "Enter" && (skillsLoading || pluginsLoading || mentionFilesLoading)) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Backspace" && composer.length === 0 && selectedSkills.length > 0) {
      event.preventDefault();
      setSelectedSkills((current) => current.slice(0, -1));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if ((event.ctrlKey || event.metaKey) && turnRunningRef.current && activeTurnIdRef.current) void steerMessage();
      else void sendMessage();
    }
  }

  function updateAvailableSkills(skills: Skill[]) {
    const enabled = skills.filter((skill) => skill.enabled);
    const enabledPaths = new Set(enabled.map((skill) => skill.path));
    setAvailableSkills(enabled);
    setSelectedSkills((current) => current.filter((skill) => enabledPaths.has(skill.path)));
  }

  async function prefetchThread(thread: Thread) {
    if (conversationCacheRef.current.has(thread.id) || prefetchingThreadsRef.current.has(thread.id)) return;
    prefetchingThreadsRef.current.add(thread.id);
    try {
      const result = await api<{ thread: Thread }>(`/api/threads/${thread.id}`);
      const prefetchedThread = result.thread;
      if (!prefetchedThread) return;
      conversationCacheRef.current.set(thread.id, {
        items: transcript(prefetchedThread),
        scrollTop: Number.MAX_SAFE_INTEGER,
        composer: "",
        attachments: [],
        selectedSkills: [],
      });
      setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, ...prefetchedThread } : item));
    } catch {
      // Hover prefetch is an optimization; openThread still performs the authoritative resume.
    } finally {
      prefetchingThreadsRef.current.delete(thread.id);
    }
  }

  async function openThread(thread: Thread, projectOverride?: Project | null) {
    rememberConversation();
    openThreadAbortRef.current?.abort();
    const controller = new AbortController();
    openThreadAbortRef.current = controller;
    const requestId = ++openThreadRequestRef.current;
    const cached = conversationCacheRef.current.get(thread.id);
    resetCurrentTurnState();
    selectedThreadRef.current = thread.id;
    setSelectedThreadId(thread.id);
    setMobileThreads(false);
    setThreadLoading(true);
    setItems(cached?.items ?? transcript(thread));
    setComposer(cached?.composer ?? "");
    setAttachments(cached?.attachments ?? []);
    setSelectedSkills(cached?.selectedSkills ?? []);
    pendingScrollRestoreRef.current = cached?.scrollTop ?? null;
    forceLatestRef.current = !cached;
    discardPendingDeltas();
    setActiveTurnId(null);
    activeTurnIdRef.current = null;
    setFatalError("");
    try {
      const result = await api<{ thread: Thread; model: string; modelProvider: string; reasoningEffort?: ReasoningEffort | null; approvalPolicy: ApprovalPolicy; networkAccess?: boolean }>(`/api/threads/${thread.id}/resume`, { method: "POST", body: "{}", signal: controller.signal });
      if (requestId !== openThreadRequestRef.current || selectedThreadRef.current !== thread.id) return;
      const resumedThread = { ...result.thread, model: result.model, modelProvider: result.modelProvider, reasoningEffort: result.reasoningEffort, approvalPolicy: result.approvalPolicy, networkAccess: result.networkAccess ?? result.thread.networkAccess ?? bootstrap?.settings.networkAccess ?? true };
      setThreads((current) => current.some((item) => item.id === thread.id)
        ? current.map((item) => item.id === thread.id ? { ...item, ...resumedThread } : item)
        : [{ ...thread, ...resumedThread }, ...current]);
      const resumedItems = transcript(resumedThread);
      pendingScrollRestoreRef.current = cached?.scrollTop ?? Number.MAX_SAFE_INTEGER;
      setItems(resumedItems);
      conversationCacheRef.current.set(thread.id, {
        items: resumedItems,
        scrollTop: cached?.scrollTop ?? Number.MAX_SAFE_INTEGER,
        composer: cached?.composer ?? "",
        attachments: cached?.attachments ?? [],
        selectedSkills: cached?.selectedSkills ?? [],
      });
      const resumedRunning = typeof resumedThread.status === "object" && resumedThread.status?.type === "active";
      turnRunningRef.current = resumedRunning;
      setTurnRunning(resumedRunning);
      const providerId = threadProviderId(resumedThread);
      const saved = savedModelSelection(projectOverride?.id ?? selectedProject?.id ?? null, result.thread.id);
      setSelectedProviderId(providerId);
      setSelectedModel(saved?.model || result.model || bootstrap?.providers.find((item) => item.id === providerId)?.model || "");
      setSelectedEffort(saved?.effort ?? result.reasoningEffort ?? "");
      setSelectedApprovalPolicy(result.approvalPolicy ?? bootstrap?.settings.approvalPolicy ?? "on-request");
      setSelectedNetworkAccess(Boolean(result.networkAccess ?? result.thread.networkAccess ?? bootstrap?.settings.networkAccess ?? true));
    } catch (reason) {
      if (requestId !== openThreadRequestRef.current || selectedThreadRef.current !== thread.id) return;
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setFatalError(reason instanceof Error ? reason.message : "会话恢复失败");
    } finally {
      if (requestId === openThreadRequestRef.current && selectedThreadRef.current === thread.id) setThreadLoading(false);
    }
  }

  async function createThread(useDefaultApproval = false, preserveSendingState = false) {
    if (!selectedProject) return null;
    rememberConversation();
    openThreadAbortRef.current?.abort();
    openThreadRequestRef.current += 1;
    setThreadLoading(false);
    if (!preserveSendingState) resetCurrentTurnState();
    const approvalPolicy = useDefaultApproval ? bootstrap?.settings.approvalPolicy ?? "on-request" : selectedApprovalPolicy;
    const networkAccess = useDefaultApproval ? bootstrap?.settings.networkAccess ?? true : selectedNetworkAccess;
    const result = await api<{ thread: Thread; approvalPolicy: ApprovalPolicy; networkAccess?: boolean }>("/api/threads", {
      method: "POST",
      body: JSON.stringify({ projectId: selectedProject.id, providerId: selectedProviderId || null, model: selectedModel || undefined, effort: selectedEffort || undefined, approvalPolicy, networkAccess }),
    });
    const createdThread = { ...result.thread, approvalPolicy: result.approvalPolicy ?? approvalPolicy, networkAccess: result.networkAccess ?? networkAccess };
    setThreads((current) => [createdThread, ...current.filter((item) => item.id !== createdThread.id)]);
    setSelectedThreadId(result.thread.id);
    selectedThreadRef.current = result.thread.id;
    setSelectedApprovalPolicy(createdThread.approvalPolicy);
    setSelectedNetworkAccess(Boolean(createdThread.networkAccess));
    setSelectedSkills([]);
    localStorage.setItem(selectionKey(selectedProject.id, result.thread.id), JSON.stringify({ providerId: selectedProviderId, model: selectedModel, effort: selectedEffort }));
    setItems([]);
    setMobileThreads(false);
    return result.thread.id;
  }

  async function startMessage(payload: OutgoingMessage, forcedThreadId?: string | null, forcedSelection?: { model?: string; effort?: ReasoningEffort | ""; inheritThreadSettings?: boolean }) {
    const text = payload.text.trim();
    if ((!text && payload.attachments.length === 0 && payload.skills.length === 0) || sendingRef.current || !selectedProject) return;
    sendingRef.current = true;
    const operationId = ++sendingOperationRef.current;
    setSending(true);
    setFatalError("");
    let clientId: string | null = null;
    try {
      const providerChanged = selectedThread && threadProviderId(selectedThread) !== selectedProviderId;
      const threadId = forcedThreadId || (!selectedThreadId || providerChanged ? await createThread(false, true) : selectedThreadId);
      if (!threadId) return;
      const targetThread = threads.find((thread) => thread.id === threadId);
      const targetModel = forcedSelection?.inheritThreadSettings ? undefined : forcedSelection?.model || targetThread?.model || selectedModel || undefined;
      const targetEffort = forcedSelection?.inheritThreadSettings ? undefined : forcedSelection?.effort || targetThread?.reasoningEffort || selectedEffort || undefined;
      const messageClientId = createClientId();
      clientId = messageClientId;
      optimisticUserItemId.current = messageClientId;
      const optimisticContent = optimisticMessageContent(payload, text);
      if (threadId === selectedThreadRef.current) setItems((current) => [...current, { id: messageClientId, type: "userMessage", content: optimisticContent }]);
      setThreads((current) => current.map((thread) => thread.id === threadId && !thread.preview?.trim()
        ? { ...thread, preview: text, updatedAt: Math.floor(Date.now() / 1000) }
        : thread));
      if (threadId === selectedThreadRef.current && operationId === sendingOperationRef.current) {
        turnRunningRef.current = true;
        setTurnRunning(true);
        const startedAtMs = Date.now();
        activeTurnStartedAtRef.current = startedAtMs;
        setActiveTurnStartedAtMs(startedAtMs);
      }
      const result = await api<{ turn: { id: string } }>(`/api/threads/${threadId}/turns`, {
        method: "POST",
        body: JSON.stringify({ text, clientId: messageClientId, projectId: selectedProject.id, model: targetModel, effort: targetEffort, approvalPolicy: selectedApprovalPolicy, networkAccess: selectedNetworkAccess, skills: payload.skills.map(({ name, path }) => ({ name, path })), attachments: payload.attachments.map(({ id: _id, size: _size, ...item }) => item) }),
      });
      if (threadId === selectedThreadRef.current && operationId === sendingOperationRef.current) {
        setActiveTurnId(result.turn.id);
        activeTurnIdRef.current = result.turn.id;
      }
    } catch (reason) {
      if (operationId === sendingOperationRef.current) {
        turnRunningRef.current = false;
        setTurnRunning(false);
        activeTurnStartedAtRef.current = null;
        setActiveTurnStartedAtMs(null);
        optimisticUserItemId.current = null;
        const message = reason instanceof Error ? reason.message : "消息发送失败";
        setItems((current) => [...current, { id: `${clientId || createClientId()}:error`, type: "turnError", text: message, status: "failed" }]);
      }
    } finally {
      if (operationId === sendingOperationRef.current) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }

  async function sendMessage(payloadOverride?: OutgoingMessage, forcedThreadId?: string | null, forcedSelection?: { model?: string; effort?: ReasoningEffort | ""; inheritThreadSettings?: boolean }) {
    const payload = payloadOverride ?? { text: composer, attachments, skills: selectedSkills };
    if ((!payload.text.trim() && payload.attachments.length === 0 && payload.skills.length === 0) || !selectedProject) return;
    scrollConversationAfterSend();
    if ((turnRunningRef.current || sendingRef.current) && !payload.fromQueue) {
      const threadId = forcedThreadId || selectedThreadId;
      if (!threadId) return;
      setQueuedMessages((current) => [...current, { ...payload, id: createClientId(), threadId }]);
      if (!payloadOverride) {
        setComposer("");
        setAttachments([]);
        setSelectedSkills([]);
      }
      return;
    }
    if (sendingRef.current) return;
    if (!payloadOverride) {
      setComposer("");
      setAttachments([]);
      setSelectedSkills([]);
    }
    await startMessage(payload, forcedThreadId ?? (payload.fromQueue ? selectedThreadId : undefined), forcedSelection);
  }

  async function steerMessage(payloadOverride?: OutgoingMessage, forcedThreadId?: string | null) {
    const payload = payloadOverride ?? { text: composer, attachments, skills: selectedSkills };
    const text = payload.text.trim();
    const threadId = forcedThreadId || selectedThreadId;
    const expectedTurnId = activeTurnIdRef.current;
    if ((!text && payload.attachments.length === 0 && payload.skills.length === 0) || !selectedProject || !threadId || !turnRunningRef.current || !expectedTurnId || sendingRef.current) return false;
    scrollConversationAfterSend();
    sendingRef.current = true;
    const operationId = ++sendingOperationRef.current;
    setSending(true);
    setFatalError("");
    const clientId = createClientId();
    optimisticUserItemId.current = clientId;
    if (!payloadOverride) {
      setComposer("");
      setAttachments([]);
      setSelectedSkills([]);
    }
    if (threadId === selectedThreadRef.current) {
      setItems((current) => [...current, { id: clientId, turnId: expectedTurnId, type: "userMessage", content: optimisticMessageContent(payload, text) }]);
    }
    try {
      const result = await api<{ turnId: string }>(`/api/threads/${threadId}/steer`, {
        method: "POST",
        body: JSON.stringify({ text, clientId, projectId: selectedProject.id, expectedTurnId, skills: payload.skills.map(({ name, path }) => ({ name, path })), attachments: payload.attachments.map(({ id: _id, size: _size, ...item }) => item) }),
      });
      if (result.turnId !== expectedTurnId) throw new Error("追加消息返回了不一致的任务 ID");
      return true;
    } catch (reason) {
      if (operationId === sendingOperationRef.current && threadId === selectedThreadRef.current) {
        optimisticUserItemId.current = null;
        const message = reason instanceof Error ? reason.message : "无法立即追加消息";
        setItems((current) => [...current.filter((item) => item.id !== clientId), { id: `${clientId}:error`, turnId: expectedTurnId, type: "turnError", text: message, status: "failed" }]);
      }
      return false;
    } finally {
      if (operationId === sendingOperationRef.current) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }

  async function steerQueuedMessage(message: QueuedMessage) {
    if (await steerMessage(message, message.threadId)) {
      setQueuedMessages((current) => current.filter((item) => item.id !== message.id));
    }
  }

  useEffect(() => {
    if (turnRunning || sending || !selectedThreadId) return;
    const next = queuedMessages.find((item) => item.threadId === selectedThreadId);
    if (!next) return;
    setQueuedMessages((current) => current.filter((item) => item.id !== next.id));
    void startMessage({ ...next, fromQueue: true }, next.threadId);
  }, [queuedMessages, selectedThreadId, sending, turnRunning]);

  async function switchRetryProvider(providerId: string) {
    if (!selectedThread) throw new Error("当前没有可重试的会话");
    const provider = providerId ? bootstrap?.providers.find((entry) => entry.id === providerId && entry.enabled) : null;
    if (providerId && !provider) throw new Error("所选供应商不存在或未启用");
    const model = providerId === selectedProviderId
      ? selectedModel || provider?.model || selectedThread.model || ""
      : provider?.model || "";
    const effort = providerId === selectedProviderId ? selectedEffort : "";
    const result = await api<{ thread: Thread; model: string; modelProvider: string; reasoningEffort?: ReasoningEffort | null }>(`/api/threads/${selectedThread.id}/provider`, {
      method: "POST",
      body: JSON.stringify({ providerId: providerId || null, model: model || undefined, effort: effort || undefined }),
    });
    setSelectedProviderId(providerId);
    setSelectedModel(result.model || model);
    setSelectedEffort(result.reasoningEffort ?? effort);
    const reasoningEffort = result.reasoningEffort ?? effort;
    setThreads((current) => current.map((thread) => thread.id === selectedThread.id
      ? { ...thread, ...result.thread, model: result.model || model, modelProvider: result.modelProvider, reasoningEffort: reasoningEffort || null }
      : thread));
    localStorage.setItem(selectionKey(selectedProject?.id ?? null, selectedThread.id), JSON.stringify({ providerId, model: result.model || model, effort: reasoningEffort }));
    return { model: result.model || model, effort: reasoningEffort, inheritThreadSettings: true };
  }

  async function resendUserMessage(item: ThreadItem, providerId = selectedProviderId) {
    if (!selectedThread) return;
    try {
      const selection = await switchRetryProvider(providerId);
      await sendMessage(outgoingFromItem(item, availableSkills), selectedThread.id, selection);
    } catch (reason) {
      setFatalError(reason instanceof Error ? `重试供应商切换失败：${reason.message}` : "重试供应商切换失败");
    }
  }

  function regenerateMessage(item: ThreadItem, providerId = selectedProviderId) {
    const index = items.findIndex((entry) => entry.id === item.id);
    const userItem = items.slice(0, index).reverse().find((entry) => entry.type === "userMessage");
    if (!userItem) return;
    void resendUserMessage(userItem, providerId);
  }

  async function editAndBranch(item: ThreadItem, preset?: string, skipPrompt = false) {
    if (!selectedThread || !item.turnId || turnRunningRef.current || sendingRef.current) {
      setFatalError(turnRunningRef.current || sendingRef.current ? "请先等待当前回复结束，再编辑或重新生成。" : "这条历史消息缺少轮次信息，无法从这里创建分支。");
      return;
    }
    const original = outgoingFromItem(item, availableSkills);
    const edited = skipPrompt ? (preset ?? original.text) : window.prompt("编辑消息并从这里创建新分支", preset ?? original.text);
    if (edited === null || !edited.trim()) return;
    sendingRef.current = true;
    setSending(true);
    setFatalError("");
    try {
      const result = await api<{ thread: Thread; approvalPolicy?: ApprovalPolicy; networkAccess?: boolean }>(`/api/threads/${selectedThread.id}/fork`, {
        method: "POST",
        body: JSON.stringify({ beforeTurnId: item.turnId }),
      });
      const forked = { ...result.thread, approvalPolicy: result.approvalPolicy ?? selectedApprovalPolicy, networkAccess: result.networkAccess ?? selectedNetworkAccess };
      setThreads((current) => [forked, ...current.filter((thread) => thread.id !== forked.id)]);
      setSelectedThreadId(forked.id);
      selectedThreadRef.current = forked.id;
      setItems(transcript(forked));
      setSelectedNetworkAccess(Boolean(forked.networkAccess));
      localStorage.setItem(selectionKey(selectedProject?.id ?? null, forked.id), JSON.stringify({ providerId: selectedProviderId, model: selectedModel, effort: selectedEffort }));
      sendingRef.current = false;
      setSending(false);
      await startMessage({ ...original, text: edited.trim() }, forked.id);
    } catch (reason) {
      setFatalError(reason instanceof Error ? `创建分支失败：${reason.message}` : "创建分支失败");
    } finally {
      sendingRef.current = false;
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

  async function renameThread(thread: Thread) {
    const name = window.prompt("重命名会话", threadTitle(thread));
    if (name === null || !name.trim()) return;
    try {
      const result = await api<{ thread: { name: string } }>(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, name: result.thread.name } : item));
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : "会话重命名失败");
    }
  }

  async function toggleThreadPin(thread: Thread) {
    try {
      const result = await api<{ thread: { pinned: boolean } }>(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ pinned: !thread.pinned }) });
      setThreads((current) => current
        .map((item) => item.id === thread.id ? { ...item, pinned: result.thread.pinned } : item)
        .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)));
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : "会话置顶失败");
    }
  }

  async function archiveThread(thread: Thread) {
    if (thread.id === selectedThreadId && turnRunning) {
      setFatalError("当前会话还在运行，请先停止后再归档。");
      return;
    }
    try {
      await api(`/api/threads/${thread.id}/archive`, { method: "POST", body: "{}" });
      setThreads((current) => current.filter((item) => item.id !== thread.id));
      setQueuedMessages((current) => current.filter((item) => item.threadId !== thread.id));
      if (thread.id === selectedThreadId) {
        openThreadAbortRef.current?.abort();
        openThreadRequestRef.current += 1;
        conversationCacheRef.current.delete(thread.id);
        setThreadLoading(false);
        setSelectedThreadId(null);
        selectedThreadRef.current = null;
        setItems([]);
        discardPendingDeltas();
        setSelectedNetworkAccess(bootstrap?.settings.networkAccess ?? true);
      }
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : "会话归档失败");
    }
  }

  async function restoreThread(thread: Thread) {
    try {
      await api(`/api/threads/${thread.id}/unarchive`, { method: "POST", body: "{}" });
      setThreads((current) => current.filter((item) => item.id !== thread.id));
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : "恢复会话失败");
      throw reason;
    }
  }

  async function selectSearchResult(thread: Thread) {
    if (!bootstrap) return;
    const project = bootstrap.projects.find((item) => item.id === thread.projectId)
      ?? bootstrap.projects.find((item) => item.path.replaceAll("\\", "/").toLowerCase() === thread.cwd?.replaceAll("\\", "/").replace(/^\/\/\?\//, "").toLowerCase());
    if (!project) throw new Error("这个会话所属项目已从工作台移除，请先重新添加项目目录。");
    if (thread.archived) await restoreThread(thread);
    setShowArchived(false);
    setSelectedProjectId(project.id);
    await openThread({ ...thread, archived: false }, project);
  }

  async function openScheduledThread(threadId: string, projectId?: string | null) {
    if (!bootstrap) throw new Error("工作台尚未加载完成");
    let project = bootstrap.projects.find((item) => item.id === projectId);
    let targetThread: Thread | null = null;
    if (!project) {
      const result = await api<{ thread: Thread }>(`/api/threads/${threadId}`);
      targetThread = result.thread;
      project = bootstrap.projects.find((item) => item.id === result.thread?.projectId)
        ?? bootstrap.projects.find((item) => normalizeThreadPath(item.path) === normalizeThreadPath(result.thread?.cwd));
    }
    if (!project) {
      throw new Error("这条通知所属的项目已从工作台移除，请先重新添加项目目录");
    }
    const timestamp = Math.floor(Date.now() / 1000);
    setScheduledTasksDialog(false);
    setShowArchived(false);
    setSelectedProjectId(project.id);
    await openThread(targetThread ?? { id: threadId, projectId: project.id, preview: "定时任务结果", cwd: project.path, createdAt: timestamp, updatedAt: timestamp }, project);
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
      conversationCacheRef.current.delete(thread.id);
      setThreads((current) => current.filter((item) => item.id !== thread.id));
      setQueuedMessages((current) => current.filter((item) => item.threadId !== thread.id));
      if (thread.id === selectedThreadId) {
        openThreadAbortRef.current?.abort();
        openThreadRequestRef.current += 1;
        conversationCacheRef.current.delete(thread.id);
        setThreadLoading(false);
        setSelectedThreadId(null);
        selectedThreadRef.current = null;
        setItems([]);
        discardPendingDeltas();
        setPendingRequests([]);
        setAttachments([]);
        setSelectedSkills([]);
        setSelectedApprovalPolicy(bootstrap?.settings.approvalPolicy ?? "on-request");
        setSelectedNetworkAccess(bootstrap?.settings.networkAccess ?? true);
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
        setSelectedProjectId(null); setSelectedThreadId(null); setItems([]); setWorkspacePanel(false); setSelectedSkills([]); setSelectedNetworkAccess(bootstrap?.settings.networkAccess ?? true);
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
    ? {
        "--workspace-background": `url(/api/appearance/background?v=${bootstrap.appearance.updatedAt ?? 0})`,
        "--background-opacity": bootstrap.settings.backgroundOpacity,
        "--background-size": bootstrap.settings.backgroundFit === "stretch" ? "100% 100%" : bootstrap.settings.backgroundFit === "tile" ? "auto" : bootstrap.settings.backgroundFit,
        "--background-position": bootstrap.settings.backgroundPosition,
        "--background-repeat": bootstrap.settings.backgroundFit === "tile" ? "repeat" : "no-repeat",
        "--background-blur": `${bootstrap.settings.backgroundBlur}px`,
        "--background-inset": `${-bootstrap.settings.backgroundBlur}px`,
        "--background-panel-opacity": `${Math.round(bootstrap.settings.backgroundPanelOpacity * 100)}%`,
      } as CSSProperties
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
              <button className="project-button" onClick={() => { rememberConversation(); openThreadAbortRef.current?.abort(); openThreadRequestRef.current += 1; threadListRequestRef.current += 1; setThreadLoading(false); selectedThreadRef.current = null; discardPendingDeltas(); setSelectedProjectId(project.id); setSelectedThreadId(null); setItems([]); setAttachments([]); setSelectedSkills([]); setSelectedApprovalPolicy(bootstrap.settings.approvalPolicy); setMobileProjects(false); }}>
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
          <div className="header-actions"><button className="icon-button" onClick={() => setGlobalSearchOpen(true)} aria-label="搜索所有会话" title="搜索所有会话"><Search size={17} /></button><button className={`icon-button ${showArchived ? "active-tool" : ""}`} disabled={!selectedProject} onClick={() => setShowArchived((value) => !value)} aria-label={showArchived ? "返回当前会话列表" : "查看已归档列表"} title={showArchived ? "返回当前会话列表" : "查看已归档列表（不会归档会话）"}><Archive size={17} /></button><button className="icon-button" disabled={!selectedProject || bootstrap.bridge.status !== "ready" || showArchived} onClick={() => void createThread(true)} aria-label="新会话"><MessageSquarePlus size={18} /></button><button className="icon-button mobile-only" onClick={() => setMobileThreads(false)} aria-label="关闭会话栏"><X size={18} /></button></div>
        </header>
        <div className="thread-search"><Search size={15} /><input value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} placeholder="搜索会话" /></div>
        {showArchived && <div className="archive-view-note"><Archive size={13} /> 当前仅查看已归档列表，不会自动归档其他会话</div>}
        <nav className="thread-list">
          {visibleThreads.map((thread) => (
            <div key={thread.id} className={`thread-row ${thread.id === selectedThreadId ? "active" : ""} ${thread.pinned ? "pinned" : ""}`}>
              <button className="thread-button" onMouseEnter={() => void prefetchThread(thread)} onFocus={() => void prefetchThread(thread)} onClick={() => void (thread.archived ? selectSearchResult(thread) : openThread(thread))}>
                <span className="thread-title">{threadTitle(thread)}</span><span className="thread-meta">{friendlyTime(thread.updatedAt || thread.createdAt)}</span>
              </button>
              <ThreadMenu thread={thread} disabled={thread.id === selectedThreadId && turnRunning} onRename={(item) => void renameThread(item)} onTogglePin={(item) => void toggleThreadPin(item)} onArchive={(item) => void archiveThread(item)} onRestore={(item) => void restoreThread(item)} onDelete={(item) => void deleteThread(item)} />
            </div>
          ))}
          {selectedProject && threads.length === 0 && <div className="empty-threads">{showArchived ? <Archive size={22} /> : <MessageSquarePlus size={22} />}<span>{showArchived ? "这个项目没有已归档会话" : "这个项目还没有会话"}</span>{!showArchived && <button onClick={() => void createThread(true)}>新建会话</button>}</div>}
        </nav>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div className="mobile-header-buttons"><button className="icon-button" onClick={() => setMobileProjects(true)} aria-label="打开项目栏"><Menu size={19} /></button><button className="icon-button" onClick={() => setMobileThreads(true)} aria-label="打开会话栏"><PanelLeft size={19} /></button></div>
          <button className="icon-button desktop-thread-toggle" onClick={() => setThreadsCollapsed((value) => !value)} title={threadsCollapsed ? "展开会话记录" : "折叠会话记录"} aria-label={threadsCollapsed ? "展开会话记录" : "折叠会话记录"}>{threadsCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
          <div className="conversation-title"><strong>{selectedThread ? threadTitle(selectedThread) : selectedProject?.name || "Codex 工作台"}</strong><span>{selectedProject?.path || "创建或选择一个项目开始"}</span></div>
          <button className="icon-button mobile-tools-button" onClick={() => setMobileToolsOpen((value) => !value)} aria-label="更多会话工具"><MoreHorizontal size={19} /></button>
          <div className={`conversation-tools ${mobileToolsOpen ? "mobile-open" : ""}`}>
            <label className="approval-policy-picker" title="当前会话的命令审批策略"><ShieldCheck size={15} /><select value={selectedApprovalPolicy} disabled={!selectedProject || turnRunning} onChange={(event) => void selectApprovalPolicy(event.target.value as ApprovalPolicy)}><option value="on-request">需要审批</option><option value="never">自动审批</option></select></label>
            <button className={`network-access-toggle ${selectedNetworkAccess ? "enabled" : ""}`} disabled={!selectedProject || turnRunning} title={selectedNetworkAccess ? "当前会话允许命令访问网络；应用代理会传给 Codex" : "当前会话的命令网络访问被沙箱阻止"} onClick={() => void selectNetworkAccess(!selectedNetworkAccess)}>{selectedNetworkAccess ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{selectedNetworkAccess ? "允许联网" : "禁止联网"}</span></button>
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
            <button className="icon-button" disabled={!selectedProject} title="Skills 管理（已启用的 Skill 可智能调用）" aria-label="Skills 管理" onClick={() => { setMobileToolsOpen(false); setSkillsDialog(true); }}><Sparkles size={17} /></button>
            <button className="icon-button" title="插件市场与已安装插件" aria-label="插件" onClick={() => { setMobileToolsOpen(false); setPluginsDialog(true); }}><Boxes size={17} /></button>
            <button className="icon-button" title="定时任务" aria-label="定时任务" onClick={() => { setMobileToolsOpen(false); setScheduledTasksDialog(true); }}><CalendarClock size={17} /></button>
            <button className="icon-button notification-button" title="通知中心" aria-label={`通知中心，${notificationSummary.unread} 条未读`} onClick={() => { setMobileToolsOpen(false); setNotificationDialog(true); }}><Bell size={17} />{notificationSummary.unread > 0 && <span>{notificationSummary.unread > 99 ? "99+" : notificationSummary.unread}</span>}</button>
            <button className={`icon-button ${workspacePanel ? "active-tool" : ""}`} disabled={!selectedProject} title="项目文件和改动" aria-label="项目文件和改动" onClick={() => { setMobileToolsOpen(false); setWorkspacePanel((value) => !value); }}><Code2 size={17} /></button>
            <button className="icon-button header-settings-button" title="设置" aria-label="设置" onClick={() => { setMobileToolsOpen(false); setSettingsDialog(true); }}><Settings size={17} /></button>
            <button className="icon-button danger" disabled={!selectedThread || turnRunning} title="删除当前会话" aria-label="删除当前会话" onClick={() => { setMobileToolsOpen(false); if (selectedThread) void deleteThread(selectedThread); }}><Trash2 size={17} /></button>
          </div>
        </header>

        <div className="conversation-stage">
          <div className="conversation-scroll" ref={scrollerRef} onScroll={updateScrollPosition}>
            {fatalError && <div className="workspace-error"><WifiOff size={16} /> {fatalError}<button onClick={() => { setFatalError(""); void loadBootstrap(); }}>重试</button></div>}
            {!selectedProject ? (
              <div className="welcome-state"><div className="welcome-mark"><Bot size={30} /></div><h1>你的飞牛 Codex 工作台</h1><p>项目、会话和模型配置都留在 NAS 上。先设置 API 令牌和模型，再创建一个项目目录开始工作。</p><div className="welcome-actions"><button className="secondary-button" onClick={() => setModelPickerOpen(true)}>设置令牌与模型</button><button className="primary-button" onClick={() => setProjectDialog(true)}><Plus size={17} /> 创建项目</button></div></div>
            ) : (
              <div className="conversation-inner">
                {threadLoading && items.length === 0 && <div className="conversation-loading" role="status"><span className="spin" />正在载入聊天记录…</div>}
                <Timeline key={selectedThreadId ?? "empty"} items={items} streamingItemId={streamingItemId} turnRunning={turnRunning} activeTurnStartedAtMs={activeTurnStartedAtMs} retryProviders={retryProviders} retryProviderId={retryProviderId} projectPath={selectedProject.path} onOpenFile={openWorkspaceFile} onSuggestion={(text) => setComposer(text)} onResend={(item, providerId) => void resendUserMessage(item, providerId)} onRegenerate={regenerateMessage} onEditBranch={(item) => void editAndBranch(item)} />
                {pendingRequests.filter((request) => !request.params.threadId || request.params.threadId === selectedThreadId).map((request) => <ApprovalCard key={request.id} request={request} onResolved={(id) => setPendingRequests((current) => current.filter((item) => item.id !== id))} />)}
              </div>
            )}
          </div>
          {selectedProject && items.length > 0 && <div className="scroll-jumps" aria-label="聊天位置跳转">
            <button disabled={scrollPosition.atTop} onClick={() => jumpConversation("top")} title="跳到最顶部"><ArrowUpToLine size={15} /><span>顶部</span></button>
            <button className={!scrollPosition.atBottom ? "has-newer" : ""} disabled={scrollPosition.atBottom} onClick={() => jumpConversation("bottom")} title="跳到最新消息"><ArrowDownToLine size={15} /><span>最新</span></button>
          </div>}
        </div>

        <footer className="composer-wrap">
          <div className={`composer-box ${turnRunning || sending ? "running" : ""}`}>
            {skillMention && <SkillMentionMenu skills={mentionSkills} plugins={mentionPlugins} files={mentionFiles} activeIndex={Math.min(skillMentionIndex, Math.max(mentionOptionCount - 1, 0))} loading={skillsLoading} pluginLoading={pluginsLoading} fileLoading={mentionFilesLoading} error={skillsError} pluginError={pluginsError} fileError={mentionFilesError} limitReached={selectedSkills.length >= 6} fileLimitReached={attachments.length >= 6} onActiveIndexChange={setSkillMentionIndex} onSelect={selectMentionSkill} onSelectPlugin={selectMentionPlugin} onSelectFile={(file) => void selectMentionFile(file)} onManage={() => { setSkillMention(null); setSkillsDialog(true); }} onManagePlugins={() => { setSkillMention(null); setPluginsDialog(true); }} />}
            {selectedSkills.length > 0 && <div className="selected-skills" aria-label="本条消息强制使用的 Skills">{selectedSkills.map((skill) => <div className="skill-chip" key={skill.path} title="本条消息强制使用"><Sparkles size={13} /><span>@{skill.interface?.displayName || skill.name}</span><button onClick={() => setSelectedSkills((current) => current.filter((item) => item.path !== skill.path))} aria-label={`移除 Skill ${skill.name}`}><X size={12} /></button></div>)}</div>}
            {attachments.length > 0 && <div className="attachment-list">{attachments.map((item) => <div className="attachment-chip" key={item.id}>{item.kind === "image" ? <Image size={14} /> : <FileText size={14} />}<span><strong>{item.name}</strong><small>{Math.max(1, Math.round(item.size / 1024))} KB</small></span><button onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))} aria-label={`移除 ${item.name}`}><X size={13} /></button></div>)}</div>}
            {currentQueuedMessages.length > 0 && <div className="queued-messages"><span>等待发送 {currentQueuedMessages.length} 条（当前回复结束后自动发送）</span>{currentQueuedMessages.map((item, index) => <div key={item.id}><em>{item.text.trim() || `附件消息 ${index + 1}`}</em><button className="queued-steer-button" disabled={!canSteer} onClick={() => void steerQueuedMessage(item)} title="现在追加到当前回复" aria-label="立即追加这条待发送消息"><CornerDownRight size={12} /></button><button onClick={() => setQueuedMessages((current) => current.filter((entry) => entry.id !== item.id))} aria-label="取消待发送消息"><X size={12} /></button></div>)}</div>}
            <textarea ref={composerRef} value={composer} onChange={handleComposerChange} onSelect={(event) => updateSkillMention(composer, event.currentTarget.selectionStart)} onBlur={() => window.setTimeout(() => setSkillMention(null), 120)} onPaste={(event) => { const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (images.length > 0) { event.preventDefault(); void addAttachments(images); } }} onKeyDown={handleComposerKeyDown} placeholder={turnRunning || sending ? "继续输入，可立即追加或等待发送…" : selectedProject ? "告诉 Codex 你想完成什么… 输入 @ 选择 Skill、插件、文件或目录" : "请先选择项目"} disabled={!selectedProject || bootstrap.bridge.status !== "ready"} rows={1} />
            <div className="composer-actions"><div className="composer-left"><input ref={attachmentInputRef} className="sr-only" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.jsonl,.js,.jsx,.ts,.tsx,.css,.html,.xml,.yaml,.yml,.toml,.ini,.env,.sh,.py,.java,.go,.rs,.sql,.log,.csv" onChange={(event) => void addAttachments(event.target.files)} /><button className="attach-button" disabled={!selectedProject || attachments.length >= 6} onClick={() => attachmentInputRef.current?.click()} title="添加图片或文本/代码文件"><Paperclip size={15} /> <span>附件</span></button><button className="attach-button" disabled={!selectedProject} onClick={() => setSkillsDialog(true)} title="管理允许智能调用的 Skills"><Sparkles size={15} /> <span>Skills</span></button><span>{turnRunning || sending ? "Enter 等待发送 · Ctrl/⌘+Enter 立即追加" : "输入 @ 选择 Skill/插件/项目内容 · Enter 发送"}</span></div><div className="composer-right">{turnRunning && <button className="stop-button" onClick={() => void interrupt()}><Square size={14} /> 停止</button>}{turnRunning || sending ? <><button className="send-choice-button steer-button" onClick={() => void steerMessage()} disabled={!canSteer || (!composer.trim() && attachments.length === 0 && selectedSkills.length === 0)} title="立即影响当前正在生成的回复"><CornerDownRight size={14} /><span>立即追加</span></button><button className="send-choice-button queue-button" onClick={() => void sendMessage()} disabled={(!composer.trim() && attachments.length === 0 && selectedSkills.length === 0) || !selectedProject} title="当前回复结束后自动发送"><Clock3 size={14} /><span>等待发送</span></button></> : <button className="send-button" onClick={() => void sendMessage()} disabled={(!composer.trim() && attachments.length === 0 && selectedSkills.length === 0) || !selectedProject} aria-label="发送消息"><Send size={17} /></button>}</div></div>
          </div>
          <small className="composer-note">Codex 可能会出错，请在执行重要操作前检查文件变更和命令。</small>
        </footer>
      </main>

      <Suspense fallback={null}>
        {workspacePanel && selectedProject && <WorkspacePanel project={selectedProject} items={items} requestedFile={workspaceFileRequest} onClose={() => setWorkspacePanel(false)} />}
        {projectDialog && <ProjectDialog open bootstrap={bootstrap} onClose={() => setProjectDialog(false)} onCreated={loadBootstrap} />}
        {globalSearchOpen && <GlobalSearchDialog open onClose={() => setGlobalSearchOpen(false)} onSelect={selectSearchResult} />}
        {settingsDialog && <SettingsDialog open bootstrap={bootstrap} onClose={() => setSettingsDialog(false)} onChanged={loadBootstrap} />}
        {skillsDialog && <SkillsDialog open project={selectedProject} revision={skillsRevision} onSkillsChange={updateAvailableSkills} onClose={() => setSkillsDialog(false)} />}
        {pluginsDialog && <PluginsDialog open onClose={() => { setPluginsDialog(false); pluginsLoadedRef.current = false; }} />}
        {scheduledTasksDialog && <ScheduledTasksDialog open projects={bootstrap.projects} onClose={() => setScheduledTasksDialog(false)} onOpenThread={openScheduledThread} />}
        {notificationDialog && <NotificationCenterDialog open revision={notificationRevision} onClose={() => setNotificationDialog(false)} onOpenThread={openScheduledThread} onSummary={setNotificationSummary} />}
      </Suspense>

      {(mobileProjects || mobileThreads) && <div className="mobile-scrim" onClick={() => { setMobileProjects(false); setMobileThreads(false); }} />}
      {mobileToolsOpen && <button className="mobile-tools-scrim" onClick={() => setMobileToolsOpen(false)} aria-label="关闭更多会话工具" />}
    </div>
  );
}
