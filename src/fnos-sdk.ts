import { TrimApp } from "@trimjs/web-app";
import type { Project } from "./types";

let sdk: TrimApp | null = null;

function trimApp() {
  sdk ??= new TrimApp();
  return sdk;
}

export function projectAbsolutePath(project: Project, path = "") {
  const root = project.path.replace(/[\\/]+$/, "");
  const relative = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!relative) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root}${separator}${relative.replaceAll("/", separator)}`;
}

export async function openFnosFileManager(path: string) {
  const app = trimApp();
  await app.ready();
  if (app.isStandaloneWeb) throw new Error("当前页面不在飞牛桌面宿主中，请从 fnOS 桌面打开 Codex 工作台");
  await app.openFileManager(path);
}

export async function openFnosFile(path: string) {
  const app = trimApp();
  await app.ready();
  if (app.isStandaloneWeb) throw new Error("当前页面不在飞牛桌面宿主中，请从 fnOS 桌面打开 Codex 工作台");
  await app.openFile(path);
}
