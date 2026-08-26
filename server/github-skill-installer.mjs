import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fetch from "node-fetch";
import { createProviderAgent } from "./provider-client.mjs";

const maxArchiveBytes = 30 * 1024 * 1024;
const maxInstalledBytes = 32 * 1024 * 1024;
const maxEntries = 3_000;
const maxSkillFileBytes = 512 * 1024;

function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function parseGitHubSkillSource(value, explicitRef = "") {
  let input = String(value || "").trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) input = `https://github.com/${input}`;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw inputError("请输入有效的 GitHub 仓库或 Skill 目录地址");
  }
  if (url.hostname.toLowerCase() !== "github.com") throw inputError("目前只支持 github.com 仓库地址");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw inputError("GitHub 地址缺少仓库名称");
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  let ref = String(explicitRef || "").trim();
  let skillPath = "";
  if (["tree", "blob"].includes(parts[2])) {
    if (!ref) ref = parts[3] || "";
    skillPath = parts.slice(4).join("/");
    if (parts[2] === "blob" && basename(skillPath).toLowerCase() === "skill.md") skillPath = dirname(skillPath);
  }
  return {
    owner,
    repo,
    ref: ref || "main",
    skillPath: skillPath === "." ? "" : skillPath,
    repositoryUrl: `https://github.com/${owner}/${repo}`,
  };
}

function validateArchiveEntries(output) {
  const entries = output.split(/\r?\n/).filter(Boolean);
  if (entries.length > maxEntries) throw inputError(`仓库内容超过 ${maxEntries} 项，不能作为单个 Skill 安装`, 413);
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (isAbsolute(entry) || /^[a-z]:/i.test(entry) || normalized.split("/").includes("..")) {
      throw inputError("GitHub 压缩包包含不安全路径");
    }
  }
  return entries;
}

function runTar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw inputError(`系统缺少 tar 解压工具：${result.error.message}`, 500);
  if (result.status !== 0) throw inputError(`GitHub 压缩包无法解压：${String(result.stderr || "格式无效").trim().slice(0, 240)}`);
  return result.stdout;
}

function findSkillDirectories(root) {
  const found = [];
  let count = 0;
  let totalBytes = 0;
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      count += 1;
      if (count > maxEntries) throw inputError(`Skill 内容超过 ${maxEntries} 项`, 413);
      const path = join(directory, entry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw inputError("Skill 包含符号链接，已拒绝安装");
      if (stats.isDirectory()) {
        if (existsSync(join(path, "SKILL.md"))) found.push(path);
        walk(path);
      } else if (stats.isFile()) {
        totalBytes += stats.size;
        if (totalBytes > maxInstalledBytes) throw inputError("Skill 解压后超过 32 MB", 413);
      } else {
        throw inputError("Skill 包含不支持的文件类型");
      }
    }
  }
  if (existsSync(join(root, "SKILL.md"))) found.push(root);
  walk(root);
  return found;
}

function isInside(root, target) {
  const rest = relative(root, target);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function skillDirectoryName(path) {
  const value = basename(path).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw inputError("Skill 目录名称无效，请调整 GitHub 中的目录名");
  return value;
}

export class GitHubSkillInstaller {
  constructor({ codexHome, getProxy = () => null, fetchImpl = fetch }) {
    this.codexHome = resolve(codexHome);
    this.getProxy = getProxy;
    this.fetch = fetchImpl;
  }

  setCodexHome(codexHome) {
    this.codexHome = resolve(codexHome);
  }

  async install(input) {
    const source = parseGitHubSkillSource(input?.url, input?.ref);
    const token = String(input?.token || "").trim();
    const temporary = mkdtempSync(join(tmpdir(), "codex-fnos-skill-"));
    const archive = join(temporary, "repository.tar.gz");
    const extracted = join(temporary, "repository");
    try {
      mkdirSync(extracted);
      const downloadUrl = token
        ? `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/tarball/${encodeURIComponent(source.ref)}`
        : `https://codeload.github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/tar.gz/${encodeURIComponent(source.ref)}`;
      const headers = { accept: "application/vnd.github+json", "user-agent": "codex-fnos-web/0.9.12" };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await this.fetch(downloadUrl, {
        agent: createProviderAgent(this.getProxy()),
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok || !response.body) {
        response.body?.destroy?.();
        const message = response.status === 401 || response.status === 403 || response.status === 404
          ? "GitHub 仓库不可访问；私有仓库请填写具有读取权限的令牌，并检查地址和分支"
          : `GitHub 下载失败（HTTP ${response.status}）`;
        throw inputError(message, 502);
      }
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > maxArchiveBytes ? inputError("GitHub 压缩包超过 30 MB", 413) : null, chunk);
        },
      });
      await pipeline(response.body, limiter, createWriteStream(archive));
      validateArchiveEntries(runTar(["-tzf", archive]));
      runTar(["-xzf", archive, "-C", extracted]);
      const archiveRoots = readdirSync(extracted, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      if (archiveRoots.length !== 1) throw inputError("GitHub 压缩包结构无效");
      const repositoryRoot = resolve(extracted, archiveRoots[0].name);
      const requestedRoot = resolve(repositoryRoot, source.skillPath || ".");
      if (!isInside(repositoryRoot, requestedRoot) || !existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) {
        throw inputError("GitHub 地址中的 Skill 目录不存在", 404);
      }
      const candidates = source.skillPath
        ? (existsSync(join(requestedRoot, "SKILL.md")) ? [requestedRoot] : [])
        : findSkillDirectories(requestedRoot);
      if (candidates.length === 0) throw inputError("所选目录中没有找到 SKILL.md");
      if (candidates.length > 1) throw inputError("仓库中有多个 Skills，请使用 GitHub 的 /tree/分支/目录 地址指定一个 Skill");
      const skillRoot = candidates[0];
      findSkillDirectories(skillRoot);
      const skillFile = join(skillRoot, "SKILL.md");
      if (statSync(skillFile).size > maxSkillFileBytes || readFileSync(skillFile).includes(0)) {
        throw inputError("SKILL.md 必须是小于 512 KB 的文本文件");
      }
      const name = skillDirectoryName(skillRoot);
      const skillsRoot = join(this.codexHome, "skills");
      const destination = join(skillsRoot, name);
      if (existsSync(destination)) throw inputError(`Skill ${name} 已存在；请先手动移除旧目录再安装`, 409);
      mkdirSync(skillsRoot, { recursive: true });
      const staging = join(skillsRoot, `.install-${randomUUID()}`);
      try {
        cpSync(skillRoot, staging, { recursive: true, errorOnExist: true });
        renameSync(staging, destination);
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
      return {
        name,
        path: destination.split(sep).join("/"),
        source: `${source.owner}/${source.repo}@${source.ref}`,
        repositoryUrl: source.repositoryUrl,
      };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
