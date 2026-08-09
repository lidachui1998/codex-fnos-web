import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fetch from "node-fetch";
import { createProviderAgent } from "./provider-client.mjs";

const registryBase = "https://registry.npmjs.org";
const targetName = "x86_64-unknown-linux-musl";
const maxPackageBytes = 350 * 1024 * 1024;

export function baseVersion(value) {
  return String(value ?? "unknown").replace(/-linux-x64$/, "");
}

export function compareVersions(left, right) {
  const a = baseVersion(left).split(".").map((part) => Number(part) || 0);
  const b = baseVersion(right).split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
  }
  return 0;
}

function detectedVersion(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return `${result.stdout ?? ""} ${result.stderr ?? ""}`.match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown";
}

function isInside(root, target) {
  const rest = relative(root, target);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function assertElf(path) {
  if (!existsSync(path)) throw new Error("更新包中缺少 Codex 可执行文件");
  const descriptor = openSync(path, "r");
  const header = Buffer.alloc(4);
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("更新包中的 Codex 不是 Linux ELF 文件");
  }
}

export class CodexUpdater {
  constructor({ dataDir, bundledBin, bundledVersion, getProxy, registryUrl = registryBase }) {
    this.runtimeRoot = resolve(dataDir, "codex-runtime");
    this.activeFile = join(this.runtimeRoot, "active.json");
    this.bundledBin = isAbsolute(bundledBin) ? resolve(bundledBin) : bundledBin;
    this.bundledVersion = baseVersion(bundledVersion || detectedVersion(this.bundledBin));
    this.getProxy = getProxy;
    this.registryUrl = registryUrl.replace(/\/$/, "");
    this.busy = false;
    mkdirSync(this.runtimeRoot, { recursive: true });
  }

  status() {
    const active = this.#readActive();
    return {
      currentVersion: active?.version ?? this.bundledVersion,
      bundledVersion: this.bundledVersion,
      source: active ? "updated" : "bundled",
      binaryPath: active?.path ?? this.bundledBin,
      canUpdate: process.platform === "linux" && process.arch === "x64",
      updating: this.busy,
    };
  }

  async check() {
    const current = this.status();
    const tags = await this.#json(`${this.registryUrl}/-/package/@openai/codex/dist-tags`);
    const packageVersion = String(tags["linux-x64"] ?? "");
    if (!/^\d+\.\d+\.\d+-linux-x64$/.test(packageVersion)) throw new Error("官方仓库没有返回有效的 Linux x64 版本");
    const latestVersion = baseVersion(packageVersion);
    return {
      ...current,
      latestVersion,
      packageVersion,
      updateAvailable: compareVersions(latestVersion, current.currentVersion) > 0,
    };
  }

  async installLatest() {
    if (this.busy) throw Object.assign(new Error("Codex 更新正在进行中"), { status: 409 });
    if (process.platform !== "linux" || process.arch !== "x64") throw new Error("在线更新仅支持飞牛 Linux x86_64 环境");
    this.busy = true;
    const staging = join(this.runtimeRoot, `.staging-${randomUUID()}`);
    try {
      const update = await this.check();
      if (!update.updateAvailable) return { ...update, installed: false };
      const manifest = await this.#json(`${this.registryUrl}/@openai%2Fcodex/${encodeURIComponent(update.packageVersion)}`);
      if (manifest.name !== "@openai/codex" || manifest.version !== update.packageVersion || manifest.license !== "Apache-2.0") {
        throw new Error("官方 Codex 包元数据校验失败");
      }
      const tarballUrl = manifest.dist?.tarball;
      const integrity = manifest.dist?.integrity;
      if (!tarballUrl || !String(integrity).startsWith("sha512-")) throw new Error("官方 Codex 包缺少 SHA-512 完整性信息");

      mkdirSync(staging, { recursive: true });
      const archive = join(staging, "codex.tgz");
      await this.#download(tarballUrl, archive, integrity);
      const extracted = join(staging, "extracted");
      mkdirSync(extracted, { recursive: true });
      const tar = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8", windowsHide: true });
      if (tar.error || tar.status !== 0) throw new Error(`无法解压官方 Codex 包：${tar.error?.message || tar.stderr || tar.status}`);

      const packageRoot = join(extracted, "package");
      const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      if (packageJson.name !== manifest.name || packageJson.version !== manifest.version || packageJson.license !== "Apache-2.0") {
        throw new Error("解压后的 Codex 包元数据不一致");
      }
      const sourceTarget = join(packageRoot, "vendor", targetName);
      const sourceBin = join(sourceTarget, "bin", "codex");
      assertElf(sourceBin);

      const release = join(this.runtimeRoot, "releases", update.latestVersion);
      const releaseTarget = join(release, targetName);
      rmSync(release, { recursive: true, force: true });
      mkdirSync(release, { recursive: true });
      cpSync(sourceTarget, releaseTarget, { recursive: true });
      copyFileSync(join(packageRoot, "package.json"), join(release, "package.json"));
      const binaryPath = join(releaseTarget, "bin", "codex");
      chmodSync(binaryPath, 0o755);
      assertElf(binaryPath);
      this.#writeActive({ version: update.latestVersion, path: binaryPath });
      return { ...update, installed: true, currentVersion: update.latestVersion, binaryPath, source: "updated" };
    } finally {
      this.busy = false;
      rmSync(staging, { recursive: true, force: true });
    }
  }

  activate(status) {
    if (status.source === "bundled") {
      rmSync(this.activeFile, { force: true });
      return;
    }
    this.#writeActive({ version: status.currentVersion, path: status.binaryPath });
  }

  #readActive() {
    try {
      const value = JSON.parse(readFileSync(this.activeFile, "utf8"));
      const path = resolve(this.runtimeRoot, value.path);
      if (!isInside(this.runtimeRoot, path) || !existsSync(path)) return null;
      assertElf(path);
      return { version: baseVersion(value.version), path };
    } catch {
      return null;
    }
  }

  #writeActive(value) {
    if (!isInside(this.runtimeRoot, value.path)) throw new Error("Codex 运行时路径无效");
    mkdirSync(this.runtimeRoot, { recursive: true });
    const next = `${this.activeFile}.${randomUUID()}.tmp`;
    writeFileSync(next, `${JSON.stringify({ version: baseVersion(value.version), path: relative(this.runtimeRoot, value.path) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(next, this.activeFile);
  }

  async #json(url) {
    const response = await fetch(url, {
      agent: createProviderAgent(this.getProxy?.()),
      headers: { accept: "application/json", "user-agent": "codex-fnos-web/0.5.0" },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`官方 Codex 仓库返回 HTTP ${response.status}`), { status: 502, details: JSON.stringify(body).slice(0, 800) });
    return body;
  }

  async #download(url, output, integrity) {
    const response = await fetch(url, {
      agent: createProviderAgent(this.getProxy?.()),
      headers: { "user-agent": "codex-fnos-web/0.5.0" },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || !response.body) throw new Error(`官方 Codex 下载返回 HTTP ${response.status}`);
    const hash = createHash("sha512");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxPackageBytes) return callback(new Error("Codex 更新包超过安全大小限制"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(response.body, meter, createWriteStream(output, { mode: 0o600 }));
    const actual = `sha512-${hash.digest("base64")}`;
    if (actual !== integrity) throw new Error("Codex 更新包 SHA-512 校验失败");
  }
}
