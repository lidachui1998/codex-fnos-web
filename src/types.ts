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
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string; url?: string; path?: string; detail?: string }>;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string;
  exitCode?: number | null;
  changes?: Array<{ path: string; kind: string; diff?: string }>;
  summary?: string[];
  tool?: string;
  server?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
};

export type Turn = {
  id: string;
  status: string;
  items: ThreadItem[];
  error?: { message: string } | null;
};

export type Thread = {
  id: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status?: { type?: string } | string;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort | null;
  turns?: Turn[];
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

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
};

export type Bootstrap = {
  version: string;
  providers: ProviderProfile[];
  proxies: ProxyProfile[];
  projects: Project[];
  settings: {
    defaultProxyId: string | null;
    workspaceRoots: string[];
    approvalPolicy: "on-request" | "never";
    theme: "system" | "light" | "dark" | "ink";
    backgroundEnabled: boolean;
    backgroundOpacity: number;
  };
  bridge: BridgeState;
  account: Account | null;
  codex: CodexUpdateState;
  appearance: { hasBackground: boolean; updatedAt: number | null };
};

export type AppEvent =
  | { kind: "connected"; bridge: BridgeState }
  | { kind: "bridge_state"; state: BridgeState }
  | { kind: "bridge_error"; message: string }
  | { kind: "server_request"; request: { id: number; method: string; params: Record<string, unknown> } }
  | { kind: "notification"; method: string; params: Record<string, any> }
  | { kind: "heartbeat"; at: number };
