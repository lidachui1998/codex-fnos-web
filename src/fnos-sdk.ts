import type { TrimApp } from "@trimjs/web-app";
import sdkUrl from "@trimjs/web-app?url";
import { HostConnection } from "./host-connection";
import type { Project } from "./types";

const connection = new HostConnection<TrimApp>(async (generation) => {
  const url = new URL(sdkUrl, window.location.href);
  url.searchParams.set("connection", String(generation));
  const module = await import(/* @vite-ignore */ url.href) as { TrimApp: new () => TrimApp };
  return new module.TrimApp();
});

export function prepareFnosHost() {
  void connection.connect().catch(() => { /* File actions display actionable errors when requested. */ });
}

export async function reconnectFnosHost() {
  await connection.reconnect();
}

async function runFnosHostAction(request: (app: TrimApp) => Promise<unknown>) {
  try {
    await connection.run(request);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (/appApi\s*>=/i.test(message)) throw new Error("当前飞牛 App 尚未提供该文件接口，请检查 App 更新后重新连接飞牛。");
    if (/host bridge|connection|iframe|destroyed|not a function/i.test(message)) throw new Error("飞牛宿主连接已失效或未提供文件接口，请重新连接飞牛。若仍失败，请保存编辑后重新打开工作台。");
    throw reason;
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
  await runFnosHostAction((app) => app.openFileManager(path));
}

export async function openFnosFile(path: string) {
  await runFnosHostAction((app) => app.openFile(path));
}
