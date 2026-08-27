export type BridgeState = {
  status: "stopped" | "starting" | "initializing" | "ready" | "stopping" | "error";
  error: string | null;
  pid: number | null;
};

export type ProxyProfile = {
  id: string;
  name: string;
  httpUrlHint: string | null;
  httpsUrlHint: string | null;
  socks5UrlHint: string | null;
  noProxy: string;
  enabled: boolean;
  updatedAt: number;
};

export type ProviderProfile = {
  id: string;
  name: string;
  protocol: "responses" | "chat_completions";
  baseUrl: string;
  model: string;
  apiKeyHint: string | null;
  hasApiKey: boolean;
  hasCustomHeaders: boolean;
  proxyProfileId: string | null;
  proxyMode: "inherit" | "direct" | "profile";
  reasoningProfile: ReasoningProfile;
  enabled: boolean;
  updatedAt: number;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  defaultProviderId: string | null;
  instructions: string;
  pinned: boolean;
  updatedAt: number;
};

export type ThreadItem = {
  id: string;
  clientId?: string | null;
  turnId?: string;
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string; url?: string; path?: string; detail?: string }>;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: Array<{ path: string; kind: string; diff?: string }>;
  summary?: string[];
  tool?: string;
  server?: string;
  senderThreadId?: string;
  receiverThreadId?: string;
  receiverThreadIds?: string[];
  newThreadId?: string;
  prompt?: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  agentStatus?: string | { status?: string; message?: string | null };
  agentsStates?: Record<string, { status?: string; message?: string | null }>;
  kind?: string;
  agentThreadId?: string;
  agentPath?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  errorCode?: string;
  retrying?: boolean;
  turnStartedAt?: number | null;
  turnCompletedAt?: number | null;
  turnDurationMs?: number | null;
};

export type Turn = {
  id: string;
  status: string;
  items: ThreadItem[];
  error?: { message: string } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
};

export type Thread = {
  id: string;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  name?: string;
  pinned?: boolean;
  archived?: boolean;
  storageArchived?: boolean;
  projectId?: string;
  projectName?: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status?: { type?: string; activeFlags?: string[] } | string;
  modelProvider?: string;
  runtimeModelProvider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort | null;
  approvalPolicy?: ApprovalPolicy;
  networkAccess?: boolean;
  turns?: Turn[];
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ReasoningProfile = "auto" | "openai" | "anthropic" | "deepseek" | "qwen" | "kimi" | "glm" | "gemini" | "generic" | "none";
export type ApprovalPolicy = "on-request" | "never";

export type PendingServerRequest = {
  id: number;
  method: string;
  params: Record<string, any>;
};

export type Skill = {
  name: string;
  description: string;
  shortDescription?: string | null;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
  enabled: boolean;
  interface?: {
    displayName?: string | null;
    shortDescription?: string | null;
    iconSmall?: string | null;
    iconLarge?: string | null;
    brandColor?: string | null;
    defaultPrompt?: string | null;
  } | null;
};

export type SkillsResult = {
  cwd: string;
  skills: Skill[];
  errors: Array<{ path: string; message: string }>;
};

export type PluginSummary = {
  id: string;
  remotePluginId?: string | null;
  name: string;
  version?: string | null;
  localVersion?: string | null;
  installed: boolean;
  enabled?: boolean;
  installPolicy?: "NOT_AVAILABLE" | "AVAILABLE" | "INSTALLED_BY_DEFAULT";
  availability?: "AVAILABLE" | "DISABLED_BY_ADMIN" | string;
  disabledReason?: string | null;
  marketplaceName?: string | null;
  marketplacePath?: string | null;
  keywords?: string[];
  interface?: {
    displayName?: string | null;
    shortDescription?: string | null;
    longDescription?: string | null;
    developerName?: string | null;
    category?: string | null;
  } | null;
};

export type PluginsResult = {
  data: PluginSummary[];
  errors: Array<{ marketplacePath?: string; message?: string } | string>;
  featuredPluginIds: string[];
};

export type Schedule =
  | { type: "interval"; minutes: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; time: string; days: number[] };

export type ScheduledRun = {
  id: string;
  threadId?: string | null;
  turnId?: string | null;
  status: "running" | "succeeded" | "failed";
  output?: string | null;
  error?: string | null;
  phase: string;
  lastEventAt?: number | null;
  diagnostics: Array<{ at: number; phase: string; method: string; summary?: string | null }>;
  startedAt: number;
  completedAt?: number | null;
};

export type ScheduledTask = {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  networkAccess: boolean;
  sandboxMode: "workspace" | "unrestricted";
  providerMode: "follow" | "openai" | "provider";
  providerId?: string | null;
  providerName?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  sourceAutomationId?: string | null;
  sourceCwd?: string | null;
  sourcePrompt?: string | null;
  memoryBytes: number;
  compatibility: AutomationCompatibilityIssue[];
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  createdAt: number;
  updatedAt: number;
  runs: ScheduledRun[];
};

export type AutomationCompatibilityIssue = {
  severity: "warning" | "blocker";
  code: string;
  message: string;
  resolved?: boolean;
};

export type AutomationImportPreview = {
  sourceAutomationId?: string | null;
  name: string;
  schedule: Schedule;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  sourceCwd?: string | null;
  targetCwd: string;
  memoryBytes: number;
  enabledAfterImport: boolean;
  issues: AutomationCompatibilityIssue[];
};

export type NotificationStatus = "running" | "completed" | "failed" | "timeout" | "waiting";
export type NotificationFilter = "all" | "unread" | "running" | "failed" | "scheduled";

export type NotificationItem = {
  id: string;
  status: NotificationStatus;
  source: "chat" | "scheduled";
  title: string;
  message: string;
  threadId?: string | null;
  turnId?: string | null;
  projectId?: string | null;
  scheduleId?: string | null;
  scheduleRunId?: string | null;
  read: boolean;
  createdAt: number;
  updatedAt: number;
};

export type NotificationSummary = {
  unread: number;
  running: number;
  failed: number;
  scheduled: number;
};

export type NotificationChannel = {
  channel: "fnos" | "feishu" | "hermes";
  enabled: boolean;
  webhookUrlHint?: string | null;
  hasWebhookUrl: boolean;
  secretHint?: string | null;
  hasSecret: boolean;
  events: Array<"completed" | "failed" | "timeout" | "waiting">;
  updatedAt: number;
};

export type CodexUpdateState = {
  currentVersion: string;
  bundledVersion: string;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  updating: boolean;
  canUpdate: boolean;
  source: "bundled" | "updated";
};

export type Account = {
  account?: { type: string; email?: string | null; planType?: string | null } | null;
  requiresOpenaiAuth?: boolean;
  activeProfile?: CodexAccountProfile;
  rateLimits?: AccountRateLimits | null;
  rateLimitsError?: string | null;
};

export type CodexAccountProfile = {
  id: string;
  label: string;
  homeKey: string;
  accountType?: string | null;
  email?: string | null;
  planType?: string | null;
  authenticated: boolean;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

export type RateLimitWindow = {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};

export type RateLimitSnapshot = {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null;
  individualLimit?: { limit: string; used: string; remainingPercent: number; resetsAt: number } | null;
  spendControlReached?: boolean | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
};

export type AccountRateLimits = {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  codexRateLimits?: RateLimitSnapshot | null;
  rateLimitResetCredits?: { availableCount?: number } | null;
};

export type Bootstrap = {
  version: string;
  providers: ProviderProfile[];
  proxies: ProxyProfile[];
  projects: Project[];
  settings: {
    defaultProxyId: string | null;
    workspaceRoots: string[];
    approvalPolicy: ApprovalPolicy;
    networkAccess: boolean;
    theme: "system" | "light" | "dark" | "ink";
    backgroundEnabled: boolean;
    backgroundOpacity: number;
    backgroundFit: "cover" | "contain" | "stretch" | "tile";
    backgroundPosition: "center" | "top" | "bottom";
    backgroundBlur: number;
    backgroundPanelOpacity: number;
    fnosInstructionsEnabled: boolean;
    fnosInstructions: string;
    personalInstructions: string;
  };
  bridge: BridgeState;
  account: Account | null;
  accounts: CodexAccountProfile[];
  activeAccountId: string;
  codex: CodexUpdateState;
  appearance: { hasBackground: boolean; updatedAt: number | null };
  notificationSummary: NotificationSummary;
};

export type AppEvent =
  | { kind: "connected"; bridge: BridgeState }
  | { kind: "transport_reset" }
  | { kind: "bridge_state"; state: BridgeState }
  | { kind: "bridge_error"; message: string }
  | { kind: "server_request"; request: { id: number; method: string; params: Record<string, unknown> } }
  | { kind: "notification"; method: string; params: Record<string, any> }
  | { kind: "notification_changed"; summary: NotificationSummary; at: number }
  | { kind: "thread_created"; projectId: string; thread: Thread; at: number }
  | { kind: "outbox_changed"; threadId: string; count: number; at: number }
  | { kind: "subagent_join"; threadId: string; status: "waiting" | "finalizing" | "resumed" | "failed"; activeCount: number; rootTurnId?: string | null; turnId?: string | null; error?: string | null; at: number }
  | { kind: "heartbeat"; at: number };

export type SubagentJoinState = {
  status: "checking" | "waiting" | "finalizing";
  activeCount: number;
  rootTurnId?: string | null;
  startedAt?: number;
  error?: string | null;
};
