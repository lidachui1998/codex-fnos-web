import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function providerKey(id) {
  return `fnos-${id}`;
}

const managedConfigStart = "# BEGIN CODEX FNOS WEB MANAGED";
const managedConfigEnd = "# END CODEX FNOS WEB MANAGED";

export function preserveUnmanagedConfig(source) {
  const lines = String(source || "").split(/\r?\n/);
  const preserved = [];
  let inManagedBlock = false;
  let inManagedProvider = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === managedConfigStart) {
      inManagedBlock = true;
      continue;
    }
    if (trimmed === managedConfigEnd) {
      inManagedBlock = false;
      continue;
    }
    if (inManagedBlock) continue;
    if (/^\[model_providers\.fnos-[^\]]+\]$/.test(trimmed)) {
      inManagedProvider = true;
      continue;
    }
    if (inManagedProvider && /^\[/.test(trimmed)) inManagedProvider = false;
    if (inManagedProvider) continue;
    if (/^(model_provider|approval_policy|sandbox_mode|experimental_use_unified_exec_tool|background_terminal_max_timeout)\s*=/.test(trimmed)) continue;
    preserved.push(line);
  }
  return preserved.join("\n").trim();
}

export function modelProviderKey(id) {
  return id ? providerKey(id) : "openai";
}

export function codexRuntimeConfig(modelReasoningEffort) {
  return {
    "agents.enabled": true,
    "agents.max_concurrent_threads_per_session": 4,
    experimental_use_unified_exec_tool: true,
    background_terminal_max_timeout: 3_600_000,
    ...(modelReasoningEffort ? { model_reasoning_effort: modelReasoningEffort } : {}),
  };
}

export class AppServerBridge extends EventEmitter {
  constructor({ codexBin, codexHome, databasePath, gatewayBaseUrl, gatewayToken, stores }) {
    super();
    this.codexBin = codexBin;
    this.codexHome = codexHome;
    this.databasePath = databasePath;
    this.gatewayBaseUrl = gatewayBaseUrl;
    this.gatewayToken = gatewayToken;
    this.stores = stores;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.loginAttempts = new Map();
    this.activeTurns = new Set();
    this.state = { status: "stopped", error: null, pid: null };
    this.startPromise = null;
  }

  snapshot() {
    return { ...this.state };
  }

  hasActiveTurns() {
    return this.activeTurns.size > 0;
  }

  trackLogin(loginId) {
    if (!loginId) return;
    this.loginAttempts.set(String(loginId), { status: "pending", error: null, updatedAt: Date.now() });
  }

  loginStatus(loginId) {
    return this.loginAttempts.get(String(loginId)) ?? null;
  }

  setCodexBin(codexBin) {
    this.codexBin = codexBin;
  }

  setCodexHome(codexHome) {
    if (this.child) throw new Error("切换 Codex 账户前必须先停止 app-server");
    this.codexHome = resolve(codexHome);
    this.loginAttempts.clear();
  }

  async start() {
    if (this.state.status === "ready") return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    this.#writeConfig();
    this.#setState({ status: "starting", error: null, pid: null });
    await new Promise((resolve, reject) => {
      const child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
        cwd: this.codexHome,
        env: {
          ...this.#cleanProcessEnvironment(),
          ...this.#proxyEnvironment(),
          CODEX_HOME: this.codexHome,
          FNOS_GATEWAY_TOKEN: this.gatewayToken,
          LOG_FORMAT: "json",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      let settled = false;
      const spawnTimer = setTimeout(() => {
        child.kill();
        fail(new Error("Codex app-server 启动超时，请检查 CODEX_BIN 路径和执行权限"));
      }, 10_000);
      const fail = (error) => {
        clearTimeout(spawnTimer);
        this.#setState({ status: "error", error: error.message, pid: null });
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      child.once("error", fail);
      child.once("spawn", async () => {
        clearTimeout(spawnTimer);
        this.#setState({ status: "initializing", error: null, pid: child.pid });
        this.#consumeOutput(child);
        try {
          await this.request("initialize", {
            clientInfo: { name: "codex-fnos-web", title: "Codex fnOS Web", version: "0.9.5" },
            capabilities: { experimentalApi: true },
          }, { requireReady: false });
          this.notify("initialized", {});
          this.#setState({ status: "ready", error: null, pid: child.pid });
          settled = true;
          resolve();
        } catch (error) {
          fail(error);
        }
      });
      child.once("exit", (code, signal) => {
        this.child = null;
        this.activeTurns.clear();
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error("Codex app-server 已退出"));
        }
        this.pending.clear();
        const expected = this.state.status === "stopping";
        this.#setState({
          status: expected ? "stopped" : "error",
          error: expected ? null : `Codex app-server 已退出 (${code ?? signal ?? "unknown"})`,
          pid: null,
        });
      });
    });
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async stop() {
    if (!this.child) return;
    this.#setState({ status: "stopping", error: null, pid: this.child.pid });
    const child = this.child;
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill(), 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  request(method, params = {}, options = {}) {
    if (!this.child || (options.requireReady !== false && this.state.status !== "ready")) {
      return Promise.reject(new Error("Codex app-server 尚未就绪"));
    }
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, options.timeoutMs ?? 120_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  notify(method, params = {}) {
    if (!this.child) throw new Error("Codex app-server 尚未启动");
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result, error) {
    if (!this.child) throw new Error("Codex app-server 尚未启动");
    const message = error ? { id, error } : { id, result };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consumeOutput(child) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit("log", { level: "warn", message: line });
        return;
      }
      if (message.id !== undefined && ("result" in message || "error" in message)) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message ?? "Codex 请求失败");
          error.details = message.error;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (message.id !== undefined && message.method) {
        this.emit("event", { kind: "server_request", request: message });
        return;
      }
      if (message.method === "account/login/completed" && message.params?.loginId) {
        this.loginAttempts.set(String(message.params.loginId), {
          status: message.params.success ? "success" : "error",
          error: message.params.error || null,
          updatedAt: Date.now(),
        });
      }
      if (message.method === "turn/started" && message.params?.threadId && message.params?.turn?.id) {
        this.activeTurns.add(`${message.params.threadId}:${message.params.turn.id}`);
      }
      if (message.method === "turn/completed" && message.params?.threadId && message.params?.turn?.id) {
        this.activeTurns.delete(`${message.params.threadId}:${message.params.turn.id}`);
      }
      if (message.method === "error" && !message.params?.willRetry && message.params?.threadId) {
        const prefix = `${message.params.threadId}:`;
        for (const key of this.activeTurns) {
          if (key.startsWith(prefix)) this.activeTurns.delete(key);
        }
      }
      if (message.method) this.emit("event", { kind: "notification", ...message });
    });
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.emit("log", { level: "debug", message: message.slice(0, 4000) });
    });
  }

  #writeConfig() {
    mkdirSync(this.codexHome, { recursive: true });
    const configPath = join(this.codexHome, "config.toml");
    const unmanaged = preserveUnmanagedConfig(existsSync(configPath) ? readFileSync(configPath, "utf8") : "");
    const lines = [
      managedConfigStart,
      "model_provider = \"openai\"",
      `approval_policy = ${tomlString(this.stores.getSettings().approvalPolicy)}`,
      "sandbox_mode = \"workspace-write\"",
      "experimental_use_unified_exec_tool = true",
      "background_terminal_max_timeout = 3600000",
      "",
    ];
    for (const provider of this.stores.listProviders().filter((item) => item.enabled)) {
      const key = providerKey(provider.id);
      lines.push(
        `[model_providers.${key}]`,
        `name = ${tomlString(provider.name)}`,
        `base_url = ${tomlString(`${this.gatewayBaseUrl}/internal/providers/${provider.id}/v1`)}`,
        "wire_api = \"responses\"",
        "env_key = \"FNOS_GATEWAY_TOKEN\"",
        "request_max_retries = 2",
        "stream_max_retries = 3",
        "stream_idle_timeout_ms = 300000",
        "",
      );
    }
    lines.push(
      "[mcp_servers.fnos_schedule]",
      `command = ${tomlString(process.execPath)}`,
      `args = [${tomlString(join(dirname(fileURLToPath(import.meta.url)), "schedule-mcp.mjs"))}]`,
      "startup_timeout_sec = 10",
      "",
      "[mcp_servers.fnos_schedule.tools.create_scheduled_task]",
      "approval_mode = \"approve\"",
      "",
      "[mcp_servers.fnos_schedule.tools.create_new_conversation]",
      "approval_mode = \"approve\"",
      "",
      "[mcp_servers.fnos_schedule.tools.create_global_skill]",
      "approval_mode = \"approve\"",
      "",
      "[mcp_servers.fnos_schedule.tools.create_global_plugin]",
      "approval_mode = \"approve\"",
      "",
      "[mcp_servers.fnos_schedule.env]",
      `FNOS_SCHEDULE_DB = ${tomlString(this.databasePath)}`,
      `FNOS_CODEX_HOME = ${tomlString(this.codexHome)}`,
      `FNOS_GATEWAY_BASE_URL = ${tomlString(this.gatewayBaseUrl)}`,
      `FNOS_GATEWAY_TOKEN = ${tomlString(this.gatewayToken)}`,
      "",
    );
    lines.push(managedConfigEnd);
    const content = [lines.join("\n"), unmanaged].filter(Boolean).join("\n\n");
    writeFileSync(configPath, `${content}\n`, { mode: 0o600 });
  }

  #proxyEnvironment() {
    const defaultProxyId = this.stores.getSettings().defaultProxyId;
    const proxy = defaultProxyId ? this.stores.getProxySecret(defaultProxyId) : null;
    if (!proxy || !proxy.enabled || (!proxy.http_url && !proxy.https_url && !proxy.socks5_url)) return {};
    const noProxy = [proxy.no_proxy, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");
    const env = { NO_PROXY: noProxy, no_proxy: noProxy };
    const httpProxy = proxy.http_url || proxy.https_url;
    const httpsProxy = proxy.https_url || proxy.http_url;
    if (httpProxy) {
      env.HTTP_PROXY = httpProxy;
      env.http_proxy = httpProxy;
    }
    if (httpsProxy) {
      env.HTTPS_PROXY = httpsProxy;
      env.https_proxy = httpsProxy;
    }
    if (proxy.socks5_url) {
      env.ALL_PROXY = proxy.socks5_url;
      env.all_proxy = proxy.socks5_url;
    }
    return env;
  }

  #cleanProcessEnvironment() {
    const env = { ...process.env };
    for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
      delete env[key];
    }
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
    const runtimeDirectory = dirname(process.execPath);
    const currentPath = String(env[pathKey] || "");
    const entries = currentPath.split(delimiter).filter(Boolean);
    env[pathKey] = [runtimeDirectory, ...entries.filter((entry) => resolve(entry) !== resolve(runtimeDirectory))].join(delimiter);
    env.CODEX_FNOS_NODE_BIN = process.execPath;
    return env;
  }

  #setState(state) {
    this.state = state;
    this.emit("event", { kind: "bridge_state", state: this.snapshot() });
  }
}
