import { TrimApp } from "@trimjs/web-app";
import type { Project } from "./types";

let sdk: TrimApp | null = null;
const HOST_ACTION_TIMEOUT_MS = 8_000;

function trimApp() {
  sdk ??= new TrimApp();
  return sdk;
}

function withHostTimeout<T>(request: Promise<T>, action: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`${action}等待飞牛宿主响应超时`)), HOST_ACTION_TIMEOUT_MS);
    request.then(
      (value) => { window.clearTimeout(timeout); resolve(value); },
      (reason) => { window.clearTimeout(timeout); reject(reason); },
    );
  });
}

function fnosHostError(reason: unknown, app: TrimApp) {
  if (app.isStandaloneWeb) return new Error("当前页面不在飞牛桌面或飞牛 App 宿主中，请从 fnOS 桌面打开 Codex 工作台");
  const message = reason instanceof Error ? reason.message : String(reason || "未知错误");
  if (/appApi\s*>=/i.test(message)) return new Error("当前飞牛 App 版本不支持打开文件管理器，请升级到 1.34.0 或更高版本");
  if (/超时|timed out|timeout/i.test(message)) return new Error("飞牛文件管理器没有及时响应。请返回 fnOS 桌面后重新进入工作台再试，并确认 fnOS ≥ 1.2.0401、飞牛 App ≥ 1.34.0");
  if (/host bridge|connection|iframe|destroyed/i.test(message)) return new Error("飞牛宿主连接已失效，请从 fnOS 桌面重新打开工作台后再试");
  return new Error(`飞牛文件管理器调用失败：${message}`);
}

async function runFnosHostAction(action: string, request: (app: TrimApp) => Promise<unknown>) {
  const app = trimApp();
  try {
    // The SDK method already waits for initialization. Calling it directly also keeps the
    // navigation request as close as possible to the user's click on mobile WebView hosts.
    await withHostTimeout(request(app), action);
  } catch (reason) {
    sdk = null;
    throw fnosHostError(reason, app);
  }
}

export function projectAbsolutePath(project: Project, path = "") {
  const root = project.path.replace(/[\\/]+$/, "");
  const relative = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!relative) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root}${separator}${relative.replaceAll("/", separator)}`;
}

export async function openFnosFileManager(path: string) {
  await runFnosHostAction("打开文件管理器", (app) => app.openFileManager(path));
}

export async function openFnosFile(path: string) {
  await runFnosHostAction("打开文件", (app) => app.openFile(path));
}
