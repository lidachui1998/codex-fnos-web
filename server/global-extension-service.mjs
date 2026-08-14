import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const maxArchiveBytes = 30 * 1024 * 1024;
const maxInstalledBytes = 32 * 1024 * 1024;
const maxEntries = 3_000;
const maxInstructionBytes = 512 * 1024;

function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizeName(value, label) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    throw inputError(`${label}名称必须是 1-64 位小写字母、数字、点、下划线或连字符`);
  }
  return name;
}

function normalizeText(value, label, maximum) {
  const text = String(value || "").trim();
  if (!text) throw inputError(`${label}不能为空`);
  if (Buffer.byteLength(text) > maximum) throw inputError(`${label}内容过大`, 413);
  if (text.includes("\0")) throw inputError(`${label}不能包含空字符`);
  return text;
}

function isInside(root, target) {
  const rest = relative(root, target);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function safeArchivePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!normalized || parts.length === 0 || normalized.includes("\0") || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || parts.includes("..")) {
    throw inputError("压缩包包含不安全路径");
  }
  return parts.join("/");
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw inputError("ZIP 压缩包结构无效");
}

function extractZip(archive, destination) {
  if (!Buffer.isBuffer(archive) || archive.length === 0) throw inputError("请选择非空 ZIP 文件");
  if (archive.length > maxArchiveBytes) throw inputError("ZIP 文件不能超过 30 MB", 413);
  const endOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const entries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0) throw inputError("不支持分卷 ZIP 文件");
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw inputError("暂不支持 ZIP64 文件");
  if (entries > maxEntries) throw inputError(`压缩包内容不能超过 ${maxEntries} 项`, 413);
  if (centralOffset + centralSize > archive.length) throw inputError("ZIP 中央目录越界");

  let cursor = centralOffset;
  let installedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) throw inputError("ZIP 中央目录损坏");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (nextCursor > archive.length) throw inputError("ZIP 文件名或扩展字段越界");
    const rawEntryName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const entryName = safeArchivePath(rawEntryName);
    cursor = nextCursor;
    if ((flags & 1) !== 0) throw inputError("不支持加密 ZIP 文件");
    const unixType = (externalAttributes >>> 16) & 0o170000;
    if (unixType === 0o120000) throw inputError("ZIP 包含符号链接，已拒绝导入");
    if (rawEntryName.replaceAll("\\", "/").endsWith("/")) continue;
    if (![0, 8].includes(method)) throw inputError(`ZIP 使用了不支持的压缩算法：${method}`);
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw inputError("ZIP 本地文件头损坏");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > archive.length) throw inputError("ZIP 文件数据越界");
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: maxInstalledBytes + 1 });
    if (content.length !== uncompressedSize) throw inputError(`ZIP 文件大小校验失败：${entryName}`);
    installedBytes += content.length;
    if (installedBytes > maxInstalledBytes) throw inputError("ZIP 解压后不能超过 32 MB", 413);
    const target = resolve(destination, ...entryName.split("/"));
    if (!isInside(destination, target)) throw inputError("ZIP 解压路径越界");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const archivedMode = (externalAttributes >>> 16) & 0o777;
    writeFileSync(target, content, { mode: archivedMode || 0o600 });
  }
}

function findMarkerDirectories(root, markerParts) {
  const found = [];
  let visited = 0;
  function walk(directory) {
    const marker = join(directory, ...markerParts);
    if (existsSync(marker) && statSync(marker).isFile()) found.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > maxEntries) throw inputError(`导入内容不能超过 ${maxEntries} 项`, 413);
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw inputError("导入内容包含符号链接，已拒绝导入");
      walk(path);
    }
  }
  walk(root);
  return found;
}

function frontmatterValue(content, key) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return "";
  const line = match[1].split(/\r?\n/).find((item) => item.match(new RegExp(`^${key}\\s*:`)));
  if (!line) return "";
  const raw = line.slice(line.indexOf(":") + 1).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { return ""; }
  }
  return raw.replace(/^['"]|['"]$/g, "").trim();
}

function inspectSkillRoot(root) {
  const file = join(root, "SKILL.md");
  const stats = statSync(file);
  if (!stats.isFile() || stats.size > maxInstructionBytes) throw inputError("SKILL.md 必须是小于 512 KB 的文本文件");
  const content = readFileSync(file);
  if (content.includes(0)) throw inputError("SKILL.md 必须是文本文件");
  const text = content.toString("utf8");
  const name = normalizeName(frontmatterValue(text, "name") || basename(root), "Skill ");
  const description = normalizeText(frontmatterValue(text, "description"), "Skill description", 2_000);
  return { name, description };
}

function inspectPluginRoot(root) {
  const manifestPath = join(root, ".codex-plugin", "plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw inputError(".codex-plugin/plugin.json 不是有效 JSON");
  }
  const name = normalizeName(manifest?.name, "插件");
  const version = normalizeText(manifest?.version, "插件 version", 80);
  const description = normalizeText(manifest?.description, "插件 description", 2_000);
  return { name, version, description, manifest };
}

function installDirectory(source, destination, existingLabel) {
  if (existsSync(destination)) throw inputError(`${existingLabel}已存在；请先在工作台中移除旧版本`, 409);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.install-${randomUUID()}`);
  try {
    cpSync(source, staging, { recursive: true, errorOnExist: true });
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function readMarketplace(path) {
  if (!existsSync(path)) return { name: "fnos-personal", plugins: [] };
  if (lstatSync(path).isSymbolicLink()) throw inputError("全局插件 marketplace.json 不能是符号链接", 409);
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw inputError("全局插件 marketplace.json 已损坏，已停止写入", 409); }
  if (!value || typeof value !== "object" || !Array.isArray(value.plugins)) throw inputError("全局插件 marketplace.json 结构无效，已停止写入", 409);
  return value;
}

export class GlobalExtensionService {
  constructor({ codexHome, getCodexHome } = {}) {
    this.codexHome = codexHome ? resolve(codexHome) : null;
    this.getCodexHome = getCodexHome;
  }

  #home() {
    const value = this.getCodexHome?.() || this.codexHome;
    if (!value) throw inputError("Codex Home 未配置", 500);
    return resolve(value);
  }

  #addPluginToMarketplace(plugin) {
    const marketplaceRoot = join(this.#home(), ".agents", "plugins");
    const marketplacePath = join(marketplaceRoot, "marketplace.json");
    const marketplace = readMarketplace(marketplacePath);
    if (marketplace.plugins.some((item) => String(item?.name || "") === plugin.name)) {
      throw inputError(`插件 ${plugin.name} 已存在于全局市场`, 409);
    }
    marketplace.plugins.push({
      name: plugin.name,
      source: { source: "local", path: `./packages/${plugin.name}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      interface: { displayName: plugin.displayName || plugin.name, shortDescription: plugin.description },
    });
    mkdirSync(marketplaceRoot, { recursive: true, mode: 0o700 });
    writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, { mode: 0o600 });
    return { name: String(marketplace.name || "fnos-personal"), path: marketplacePath };
  }

  createSkill(input) {
    const name = normalizeName(input?.name, "Skill ");
    const description = normalizeText(input?.description, "Skill description", 2_000);
    const instructions = normalizeText(input?.instructions, "Skill instructions", maxInstructionBytes);
    const destination = join(this.#home(), "skills", name);
    if (existsSync(destination)) throw inputError(`Skill ${name} 已存在`, 409);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(join(destination, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`, { mode: 0o600 });
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    return { kind: "skill", name, description, path: destination.split(sep).join("/"), scope: "global" };
  }

  createPlugin(input) {
    const name = normalizeName(input?.name, "插件");
    const displayName = String(input?.displayName || name).trim().slice(0, 120) || name;
    const description = normalizeText(input?.description, "插件 description", 2_000);
    const skillName = normalizeName(input?.skillName || name, "插件 Skill ");
    const skillDescription = normalizeText(input?.skillDescription || description, "插件 Skill description", 2_000);
    const instructions = normalizeText(input?.instructions, "插件 Skill instructions", maxInstructionBytes);
    const marketplaceRoot = join(this.#home(), ".agents", "plugins");
    const destination = join(marketplaceRoot, "packages", name);
    if (existsSync(destination)) throw inputError(`插件 ${name} 已存在`, 409);
    const staging = mkdtempSync(join(tmpdir(), "codex-fnos-plugin-create-"));
    try {
      mkdirSync(join(staging, ".codex-plugin"), { recursive: true });
      mkdirSync(join(staging, "skills", skillName), { recursive: true });
      writeFileSync(join(staging, ".codex-plugin", "plugin.json"), `${JSON.stringify({ name, version: "1.0.0", description, skills: "./skills/" }, null, 2)}\n`);
      writeFileSync(join(staging, "skills", skillName, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${JSON.stringify(skillDescription)}\n---\n\n${instructions}\n`);
      installDirectory(staging, destination, `插件 ${name} `);
      let marketplace;
      try { marketplace = this.#addPluginToMarketplace({ name, displayName, description }); }
      catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
      return { kind: "plugin", name, displayName, description, path: destination.split(sep).join("/"), marketplaceName: marketplace.name, marketplacePath: marketplace.path.split(sep).join("/"), scope: "global", installed: false };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  importSkill(archive, filename = "skill.zip") {
    const temporary = mkdtempSync(join(tmpdir(), "codex-fnos-skill-import-"));
    try {
      if (/\.md$/i.test(filename)) {
        if (archive.length > maxInstructionBytes) throw inputError("SKILL.md 不能超过 512 KB", 413);
        writeFileSync(join(temporary, "SKILL.md"), archive);
      } else {
        extractZip(archive, temporary);
      }
      const candidates = findMarkerDirectories(temporary, ["SKILL.md"]);
      if (candidates.length === 0) throw inputError("导入文件中没有找到 SKILL.md");
      if (candidates.length > 1) throw inputError("导入文件包含多个 Skills，请一次只导入一个 Skill");
      const skill = inspectSkillRoot(candidates[0]);
      const destination = join(this.#home(), "skills", skill.name);
      installDirectory(candidates[0], destination, `Skill ${skill.name} `);
      return { kind: "skill", ...skill, path: destination.split(sep).join("/"), scope: "global", source: filename };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  importPlugin(archive, filename = "plugin.zip") {
    const temporary = mkdtempSync(join(tmpdir(), "codex-fnos-plugin-import-"));
    try {
      extractZip(archive, temporary);
      const candidates = findMarkerDirectories(temporary, [".codex-plugin", "plugin.json"]);
      if (candidates.length === 0) throw inputError("导入文件中没有找到 .codex-plugin/plugin.json");
      if (candidates.length > 1) throw inputError("导入文件包含多个插件，请一次只导入一个插件");
      const plugin = inspectPluginRoot(candidates[0]);
      const destination = join(this.#home(), ".agents", "plugins", "packages", plugin.name);
      installDirectory(candidates[0], destination, `插件 ${plugin.name} `);
      let marketplace;
      try { marketplace = this.#addPluginToMarketplace(plugin); }
      catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
      return { kind: "plugin", name: plugin.name, version: plugin.version, description: plugin.description, path: destination.split(sep).join("/"), marketplaceName: marketplace.name, marketplacePath: marketplace.path.split(sep).join("/"), scope: "global", source: filename, installed: false };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

export const extensionLimits = { maxArchiveBytes, maxInstructionBytes };
