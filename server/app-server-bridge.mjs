import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function providerKey(id) {
  return `fnos-${id}`;
}

export function modelProviderKey(id) {
  return id ? providerKey(id) : "openai";
}

export class AppServerBridge extends EventEmitter {
  constructor({ codexBin, codexHome, gatewayBaseUrl, gatewayToken, stores }) {
    super();
    this.codexBin = codexBin;
    this.codexHome = codexHome;
    this.gatewayBaseUrl = gatewayBaseUrl;
    this.gatewayToken = gatewayToken;
    this.stores = stores;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.state = { status: "stopped", error: null, pid: null };
    this.startPromise = null;
  }

  snapshot() {
    return { ...this.state };
  }

  setCodexBin(codexBin) {
    this.codexBin = codexBin;
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
          ...process.env,
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
            clientInfo: { name: "codex-fnos-web", title: "Codex fnOS Web", version: "0.4.1" },
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
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
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
      if (message.method) this.emit("event", { kind: "notification", ...message });
    });
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.emit("log", { level: "debug", message: message.slice(0, 4000) });
    });
  }

  #writeConfig() {
    mkdirSync(this.codexHome, { recursive: true });
    const lines = [
      "model_provider = \"openai\"",
      `approval_policy = ${tomlString(this.stores.getSettings().approvalPolicy)}`,
      "sandbox_mode = \"workspace-write\"",
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
    writeFileSync(join(this.codexHome, "config.toml"), `${lines.join("\n")}\n`, { mode: 0o600 });
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

  #setState(state) {
    this.state = state;
    this.emit("event", { kind: "bridge_state", state: this.snapshot() });
  }
}
