import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "./api-router.mjs";
import { AppServerBridge } from "./app-server-bridge.mjs";
import { AppearanceService } from "./appearance-service.mjs";
import { CodexUpdater } from "./codex-updater.mjs";
import { openDatabase } from "./database.mjs";
import {
  clearSessionCookie,
  isAuthorized,
  isSameOriginRequest,
  loadAccessControl,
  setAccessPassword,
  setSessionCookie,
  verifyAccessPassword,
} from "./lib/access-control.mjs";
import { frameAncestors } from "./lib/frame-policy.mjs";
import { readJson, sendError, sendJson, serveStatic } from "./lib/http.mjs";
import { createInternalToken, loadOrCreateMasterKey } from "./lib/security.mjs";
import { handleProviderGateway } from "./provider-gateway.mjs";
import { SseHub } from "./sse-hub.mjs";
import { SkillService } from "./skill-service.mjs";
import { Stores } from "./stores.mjs";
import { WorkspaceService } from "./workspace-service.mjs";
import { discoverWorkspaceCandidates } from "./workspace-roots.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(process.env.DATA_DIR || join(rootDir, "data"));
const distDir = join(rootDir, "dist");
const port = Number(process.env.PORT || 19090);
const host = process.env.HOST || "127.0.0.1";
const workspaceRoots = (process.env.WORKSPACE_ROOTS || join(dataDir, "workspaces"))
  .split(delimiter)
  .map((item) => item.trim())
  .filter(Boolean);
mkdirSync(join(dataDir, "workspaces"), { recursive: true });

const access = loadAccessControl(join(dataDir, "secrets", "access-token"));
const masterKey = loadOrCreateMasterKey(join(dataDir, "secrets", "master.key"));
const db = openDatabase(join(dataDir, "codex-fnos.sqlite"));
const configuredCandidates = (process.env.WORKSPACE_CANDIDATES || "")
  .split(delimiter)
  .map((item) => item.trim())
  .filter(Boolean);
const stores = new Stores(db, masterKey, workspaceRoots, [...configuredCandidates, ...discoverWorkspaceCandidates()]);
const appearance = new AppearanceService(dataDir);
const workspace = new WorkspaceService();
const updater = new CodexUpdater({
  dataDir,
  bundledBin: process.env.CODEX_BIN || "codex",
  bundledVersion: process.env.CODEX_BUNDLED_VERSION,
  getProxy: () => {
    const id = stores.getSettings().defaultProxyId;
    return id ? stores.getProxySecret(id) : null;
  },
  registryUrl: process.env.CODEX_UPDATE_REGISTRY,
});
const hub = new SseHub();
const gatewayToken = createInternalToken();
const bridge = new AppServerBridge({
  codexBin: updater.status().binaryPath,
  codexHome: resolve(process.env.CODEX_HOME || join(dataDir, "codex-home")),
  gatewayBaseUrl: `http://127.0.0.1:${port}`,
  gatewayToken,
  stores,
});
const skills = new SkillService(bridge);

bridge.on("event", (event) => hub.broadcast(event));
bridge.on("log", (event) => {
  if (process.env.NODE_ENV !== "production") console.error(`[codex:${event.level}] ${event.message}`);
});

let restartTimer;
function queueBridgeRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    bridge.restart().catch((error) => hub.broadcast({ kind: "bridge_error", message: error.message }));
  }, 400);
}

const handleApi = createApiHandler({ stores, bridge, queueBridgeRestart, appearance, updater, workspace, skills });
const loginFailures = new Map();
const loginWindowMs = 5 * 60 * 1000;
const maxLoginFailures = 5;

function loginClientKey(req) {
  return req.socket.remoteAddress || "unknown";
}

function activeLoginFailure(req) {
  const key = loginClientKey(req);
  const current = loginFailures.get(key);
  if (!current || current.resetAt <= Date.now()) {
    loginFailures.delete(key);
    return null;
  }
  return current;
}

function recordLoginFailure(req) {
  const key = loginClientKey(req);
  const current = activeLoginFailure(req);
  loginFailures.set(key, current
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: Date.now() + loginWindowMs });
}

const server = createServer(async (req, res) => {
  res.setHeader("content-security-policy", `default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors ${frameAncestors(req)}`);
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("x-content-type-options", "nosniff");
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const internal = url.pathname.match(/^\/internal\/providers\/(?<id>[^/]+)\/v1\/responses$/);
    if (req.method === "POST" && internal?.groups) {
      await handleProviderGateway(req, res, stores, gatewayToken, internal.groups.id);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/auth/status") {
      sendJson(res, 200, {
        authenticated: isAuthorized(req, access),
        setupRequired: access.setupRequired,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/setup") {
      if (!isSameOriginRequest(req)) {
        sendError(res, 403, "只允许从当前工作台设置访问密码");
        return;
      }
      if (!access.setupRequired) {
        sendError(res, 409, "访问密码已经设置，请直接登录");
        return;
      }
      const { password } = await readJson(req, 4096);
      setAccessPassword(access, password);
      setSessionCookie(req, res, access);
      sendJson(res, 200, { authenticated: true, setupRequired: false });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      if (access.setupRequired) {
        sendError(res, 409, "请先设置访问密码");
        return;
      }
      const failure = activeLoginFailure(req);
      if (failure?.count >= maxLoginFailures) {
        const retryAfter = Math.max(1, Math.ceil((failure.resetAt - Date.now()) / 1000));
        res.setHeader("retry-after", String(retryAfter));
        sendError(res, 429, `尝试次数过多，请在 ${retryAfter} 秒后重试`);
        return;
      }
      const { password } = await readJson(req, 4096);
      if (!verifyAccessPassword(access, password)) {
        recordLoginFailure(req);
        sendError(res, 401, "访问密码不正确");
        return;
      }
      loginFailures.delete(loginClientKey(req));
      setSessionCookie(req, res, access);
      sendJson(res, 200, { authenticated: true, setupRequired: false });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      clearSessionCookie(req, res);
      sendJson(res, 200, { authenticated: false, setupRequired: access.setupRequired });
      return;
    }
    if ((url.pathname.startsWith("/api/") || url.pathname === "/events") && !isAuthorized(req, access)) {
      res.setHeader("www-authenticate", "Bearer realm=codex-fnos-web");
      sendError(res, 401, "请先登录工作台");
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      hub.connect(req, res, { bridge: bridge.snapshot() });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (!serveStatic(res, distDir, url.pathname)) sendError(res, 404, "前端尚未构建");
  } catch (error) {
    if (!res.headersSent) sendError(res, error.status || 500, error.message || "服务器错误", error.details);
    else res.end();
  }
});

server.listen(port, host, () => {
  console.log(`Codex fnOS Web listening on http://${host}:${port}`);
  if (access.generated) console.log(`Internal access token saved to ${access.tokenPath}`);
  bridge.start().catch((error) => console.error(`Codex app-server unavailable: ${error.message}`));
});

async function shutdown() {
  await bridge.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
