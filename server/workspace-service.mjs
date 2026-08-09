import { execFile } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maxTextFileBytes = 1_500_000;
const maxImageFileBytes = 12 * 1024 * 1024;
const hiddenDirectories = new Set([".git", ".codex-system", ".fnos-build", "node_modules", ".pnpm-store"]);

function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  return null;
}

function relativePath(root, target) {
  return relative(root, target).split(sep).join("/");
}

function isInside(root, target) {
  const rest = relative(root, target);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function projectRoot(project) {
  return realpathSync(project.path);
}

function fileReference(value) {
  let reference = String(value || "").trim();
  if (/^file:/i.test(reference)) {
    try {
      reference = fileURLToPath(reference);
    } catch {
      throw Object.assign(new Error("文件链接格式无效"), { status: 400 });
    }
  }
  reference = reference.replace(/#L?\d+(?:-L?\d+)?$/i, "");
  reference = reference.replace(/:(\d+)(?::\d+)?$/, "");
  return reference;
}

function resolveExistingProjectPath(project, value = "") {
  const root = projectRoot(project);
  const reference = fileReference(value);
  const target = realpathSync(isAbsolute(reference) ? reference : resolve(root, reference || "."));
  if (!isInside(root, target)) throw Object.assign(new Error("文件路径超出项目目录"), { status: 403 });
  return { root, target };
}

function safeGitPath(project, value) {
  if (!value || isAbsolute(value)) throw Object.assign(new Error("文件路径无效"), { status: 400 });
  const root = projectRoot(project);
  const target = resolve(root, value);
  if (!isInside(root, target)) throw Object.assign(new Error("文件路径超出项目目录"), { status: 403 });
  return { root, path: relativePath(root, target) };
}

function changeKind(status) {
  if (status === "??") return "untracked";
  if (status.includes("D")) return "deleted";
  if (status.includes("R")) return "renamed";
  if (status.includes("A")) return "added";
  if (status.includes("U")) return "conflict";
  return "modified";
}

function parseGitStatus(output) {
  const records = output.split("\0");
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    let previousPath;
    if ((status.includes("R") || status.includes("C")) && records[index + 1]) previousPath = records[++index];
    changes.push({ path, previousPath, status, kind: changeKind(status), source: "git" });
  }
  return changes;
}

async function git(root, args) {
  return execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 12_000,
    windowsHide: true,
    maxBuffer: 2_000_000,
  });
}

export class WorkspaceService {
  list(project, value = "") {
    const { root, target } = resolveExistingProjectPath(project, value);
    if (!statSync(target).isDirectory()) throw Object.assign(new Error("目标不是目录"), { status: 400 });
    const entries = readdirSync(target, { withFileTypes: true })
      .filter((entry) => !hiddenDirectories.has(entry.name))
      .slice(0, 500)
      .map((entry) => {
        try {
          const resolved = realpathSync(resolve(target, entry.name));
          if (!isInside(root, resolved)) return null;
          const stats = statSync(resolved);
          if (!stats.isDirectory() && !stats.isFile()) return null;
          return {
            name: entry.name,
            path: relativePath(root, resolved),
            type: stats.isDirectory() ? "directory" : "file",
            size: stats.isFile() ? stats.size : null,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.type === right.type
        ? left.name.localeCompare(right.name, "zh-CN")
        : left.type === "directory" ? -1 : 1);
    const current = relativePath(root, target);
    const parent = current ? current.split("/").slice(0, -1).join("/") : null;
    return { path: current, parent, entries, truncated: entries.length >= 500 };
  }

  read(project, value) {
    const { root, target } = resolveExistingProjectPath(project, value);
    const stats = statSync(target);
    if (!stats.isFile()) throw Object.assign(new Error("目标不是文件"), { status: 400 });
    if (stats.size > maxImageFileBytes) throw Object.assign(new Error("文件超过 12 MB，无法在工作台中预览"), { status: 413 });
    const content = readFileSync(target);
    const mimeType = imageType(content);
    if (mimeType) {
      return {
        path: relativePath(root, target),
        size: stats.size,
        kind: "image",
        mimeType,
        dataUrl: `data:${mimeType};base64,${content.toString("base64")}`,
      };
    }
    if (stats.size > maxTextFileBytes) throw Object.assign(new Error("文本文件超过 1.5 MB，请使用专业编辑器打开"), { status: 413 });
    if (content.subarray(0, 8192).includes(0)) throw Object.assign(new Error("这是二进制文件，暂不支持预览"), { status: 415 });
    return {
      path: relativePath(root, target),
      size: stats.size,
      kind: "text",
      mimeType: "text/plain",
      content: content.toString("utf8"),
    };
  }

  async changes(project) {
    const root = projectRoot(project);
    try {
      const { stdout } = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      return { available: true, changes: parseGitStatus(stdout), message: "" };
    } catch (error) {
      const message = error.code === "ENOENT"
        ? "飞牛系统未安装 Git；仍可查看本次会话产生的文件变更。"
        : "该目录不是 Git 仓库，仍可浏览和阅读项目文件。";
      return { available: false, changes: [], message };
    }
  }

  async diff(project, value) {
    const { root, path } = safeGitPath(project, value);
    try {
      let result = await git(root, ["diff", "--no-ext-diff", "--no-color", "--", path]);
      if (!result.stdout) result = await git(root, ["diff", "--cached", "--no-ext-diff", "--no-color", "--", path]);
      return { path, diff: result.stdout || "这个文件没有可显示的 Git diff；如果它是未跟踪文件，请切换到“文件”查看内容。" };
    } catch {
      return { path, diff: "当前环境无法生成 Git diff。" };
    }
  }
}

export { parseGitStatus };
