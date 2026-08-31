import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const maxManifestBytes = 32 * 1024;
const maxSpritesheetBytes = 8 * 1024 * 1024;
const defaultSettings = Object.freeze({ activePetId: null, visible: true, motion: "full", scale: 1 });
const petIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizedPetId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!petIdPattern.test(id)) throw inputError("宠物 ID 必须是 1-64 位小写字母、数字、点、下划线或连字符");
  return id;
}

function limitedText(value, label, maximum, fallback = "") {
  const text = String(value ?? fallback).trim();
  if (Buffer.byteLength(text) > maximum) throw inputError(`${label}内容过大`, 413);
  if (text.includes("\0")) throw inputError(`${label}不能包含空字符`);
  return text;
}

function decodeSpritesheet(value) {
  const match = String(value || "").match(/^data:image\/webp;base64,([a-z\d+/=]+)$/i);
  if (!match) throw inputError("宠物图片必须是 WebP 文件", 415);
  const content = Buffer.from(match[1], "base64");
  if (content.length === 0) throw inputError("宠物图片不能为空");
  if (content.length > maxSpritesheetBytes) throw inputError("宠物图片不能超过 8 MB", 413);
  return content;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readWebpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    throw inputError("宠物图片不是有效的 WebP 容器", 415);
  }
  const declaredSize = buffer.readUInt32LE(4) + 8;
  if (declaredSize > buffer.length || declaredSize < 20) throw inputError("宠物 WebP 文件结构不完整", 415);
  let offset = 12;
  while (offset + 8 <= declaredSize) {
    const kind = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > declaredSize) throw inputError("宠物 WebP 数据块越界", 415);
    if (kind === "VP8X" && size >= 10) {
      return { width: readUInt24LE(buffer, dataOffset + 4) + 1, height: readUInt24LE(buffer, dataOffset + 7) + 1 };
    }
    if (kind === "VP8L" && size >= 5 && buffer[dataOffset] === 0x2f) {
      const b1 = buffer[dataOffset + 1];
      const b2 = buffer[dataOffset + 2];
      const b3 = buffer[dataOffset + 3];
      const b4 = buffer[dataOffset + 4];
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
    }
    if (kind === "VP8 " && size >= 10 && buffer[dataOffset + 3] === 0x9d && buffer[dataOffset + 4] === 0x01 && buffer[dataOffset + 5] === 0x2a) {
      return {
        width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
    }
    offset = dataOffset + size + (size % 2);
  }
  throw inputError("无法读取宠物 WebP 尺寸", 415);
}

function parseManifest(value) {
  let manifest = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > maxManifestBytes) throw inputError("宠物清单不能超过 32 KB", 413);
    try { manifest = JSON.parse(value); }
    catch { throw inputError("pet.json 或 avatar.json 不是有效 JSON"); }
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw inputError("宠物清单结构无效");
  if (Buffer.byteLength(JSON.stringify(manifest)) > maxManifestBytes) throw inputError("宠物清单不能超过 32 KB", 413);
  return manifest;
}

function inspectPackage(manifestInput, spritesheet, fallbackId = "") {
  const manifest = parseManifest(manifestInput);
  const id = normalizedPetId(manifest.id || fallbackId);
  const displayName = limitedText(manifest.displayName || id, "宠物名称", 120, id) || id;
  const description = limitedText(manifest.description, "宠物描述", 2_000);
  const dimensions = readWebpDimensions(spritesheet);
  const version = Number(manifest.spriteVersionNumber || 1);
  const expectedRows = version === 2 ? 11 : 9;
  if (![1, 2].includes(version)) throw inputError("仅支持 v1 或 v2 Codex 宠物");
  if (dimensions.width !== 1536 || dimensions.height !== 208 * expectedRows) {
    throw inputError(`宠物 v${version} 图片必须是 1536×${208 * expectedRows}，当前是 ${dimensions.width}×${dimensions.height}`);
  }
  if (manifest.frame) {
    const frame = manifest.frame;
    if (Number(frame.width) !== 192 || Number(frame.height) !== 208 || Number(frame.columns) !== 8 || Number(frame.rows) !== expectedRows) {
      throw inputError("当前工作台仅支持 192×208、8 列的标准 Codex 宠物网格");
    }
  }
  const path = String(manifest.spritesheetPath || "spritesheet.webp").replaceAll("\\", "/");
  if (isAbsolute(path) || /^[a-z]:\//i.test(path) || path.startsWith("/") || path.split("/").includes("..")) {
    throw inputError("宠物图片路径必须留在宠物目录内");
  }
  return {
    manifest: {
      id,
      displayName,
      description,
      ...(version === 2 ? { spriteVersionNumber: 2 } : {}),
      spritesheetPath: "spritesheet.webp",
    },
    version,
    width: dimensions.width,
    height: dimensions.height,
  };
}

function inside(root, target) {
  const rest = relative(root, target);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function publicPath(value) {
  return value.split(sep).join("/");
}

export class PetService {
  constructor({ codexHome, getCodexHome } = {}) {
    this.codexHome = codexHome ? resolve(codexHome) : null;
    this.getCodexHome = getCodexHome;
  }

  #home() {
    const value = this.getCodexHome?.() || this.codexHome;
    if (!value) throw inputError("Codex Home 未配置", 500);
    return resolve(value);
  }

  #root() {
    return join(this.#home(), "pets");
  }

  #settingsPath() {
    return join(this.#home(), "pet-settings.json");
  }

  #readSettings() {
    const path = this.#settingsPath();
    if (!existsSync(path)) return { ...defaultSettings };
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      return {
        activePetId: value.activePetId ? normalizedPetId(value.activePetId) : null,
        visible: value.visible !== false,
        motion: value.motion === "reduced" ? "reduced" : "full",
        scale: Math.min(1.4, Math.max(0.7, Number(value.scale) || 1)),
      };
    } catch {
      return { ...defaultSettings };
    }
  }

  #writeSettings(value) {
    const path = this.#settingsPath();
    mkdirSync(this.#home(), { recursive: true, mode: 0o700 });
    const staging = `${path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      if (existsSync(path)) rmSync(path, { force: true });
      renameSync(staging, path);
    } catch (error) {
      rmSync(staging, { force: true });
      throw error;
    }
  }

  #readPet(id) {
    const safeId = normalizedPetId(id);
    const root = this.#root();
    const directory = resolve(root, safeId);
    if (!inside(root, directory) || !existsSync(directory) || !statSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return null;
    const manifestPath = join(directory, "pet.json");
    const spritesheetPath = join(directory, "spritesheet.webp");
    if (!existsSync(manifestPath) || !existsSync(spritesheetPath) || lstatSync(manifestPath).isSymbolicLink() || lstatSync(spritesheetPath).isSymbolicLink()) return null;
    const manifest = readFileSync(manifestPath, "utf8");
    const spritesheet = readFileSync(spritesheetPath);
    const inspected = inspectPackage(manifest, spritesheet, safeId);
    const stats = statSync(spritesheetPath);
    return {
      id: inspected.manifest.id,
      displayName: inspected.manifest.displayName,
      description: inspected.manifest.description,
      spriteVersionNumber: inspected.version,
      width: inspected.width,
      height: inspected.height,
      bytes: stats.size,
      updatedAt: Math.trunc(stats.mtimeMs),
      etag: `"sha256-${createHash("sha256").update(spritesheet).digest("hex")}"`,
      path: publicPath(directory),
      spritesheetPath,
    };
  }

  list() {
    const root = this.#root();
    if (!existsSync(root)) return { data: [], errors: [] };
    const data = [];
    const errors = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const pet = this.#readPet(entry.name);
        if (pet) data.push(pet);
      } catch (error) {
        errors.push({ id: entry.name, message: error instanceof Error ? error.message : "宠物包无效" });
      }
    }
    data.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
    return { data, errors };
  }

  status() {
    const listed = this.list();
    const settings = this.#readSettings();
    if (settings.activePetId && !listed.data.some((pet) => pet.id === settings.activePetId)) settings.activePetId = null;
    return {
      pets: listed.data.map(({ path: _path, spritesheetPath: _spritesheetPath, etag: _etag, ...pet }) => pet),
      errors: listed.errors,
      settings,
    };
  }

  import(input) {
    const spritesheet = decodeSpritesheet(input?.spritesheetDataUrl);
    const inspected = inspectPackage(input?.manifest, spritesheet, input?.fallbackId);
    const root = this.#root();
    const destination = resolve(root, inspected.manifest.id);
    if (!inside(root, destination)) throw inputError("宠物安装路径越界");
    if (existsSync(destination)) throw inputError(`宠物 ${inspected.manifest.displayName} 已存在`, 409);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const staging = join(root, `.import-${randomUUID()}`);
    try {
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "pet.json"), `${JSON.stringify(inspected.manifest, null, 2)}\n`, { mode: 0o600 });
      writeFileSync(join(staging, "spritesheet.webp"), spritesheet, { mode: 0o600 });
      renameSync(staging, destination);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    const settings = this.#readSettings();
    if (!settings.activePetId) {
      settings.activePetId = inspected.manifest.id;
      settings.visible = true;
      this.#writeSettings(settings);
    }
    return { pet: this.status().pets.find((pet) => pet.id === inspected.manifest.id), status: this.status() };
  }

  updateSettings(input) {
    const current = this.#readSettings();
    const next = { ...current };
    if (Object.hasOwn(input || {}, "activePetId")) {
      next.activePetId = input.activePetId ? normalizedPetId(input.activePetId) : null;
      if (next.activePetId && !this.#readPet(next.activePetId)) throw inputError("所选宠物不存在", 404);
    }
    if (Object.hasOwn(input || {}, "visible")) next.visible = Boolean(input.visible);
    if (Object.hasOwn(input || {}, "motion")) {
      if (!["full", "reduced"].includes(input.motion)) throw inputError("宠物动画模式无效");
      next.motion = input.motion;
    }
    if (Object.hasOwn(input || {}, "scale")) {
      const scale = Number(input.scale);
      if (!Number.isFinite(scale) || scale < 0.7 || scale > 1.4) throw inputError("宠物缩放必须在 70% 到 140% 之间");
      next.scale = Math.round(scale * 100) / 100;
    }
    this.#writeSettings(next);
    return this.status();
  }

  delete(id) {
    const pet = this.#readPet(id);
    if (!pet) throw inputError("宠物不存在", 404);
    const root = this.#root();
    const trash = join(root, ".trash");
    mkdirSync(trash, { recursive: true, mode: 0o700 });
    const destination = join(trash, `${pet.id}-${Date.now()}-${randomUUID()}`);
    renameSync(resolve(root, pet.id), destination);
    const settings = this.#readSettings();
    if (settings.activePetId === pet.id) {
      settings.activePetId = null;
      this.#writeSettings(settings);
    }
    return { deleted: true, recoverable: true, quarantinePath: publicPath(destination), status: this.status() };
  }

  asset(id) {
    const pet = this.#readPet(id);
    if (!pet) throw inputError("宠物不存在", 404);
    return { path: pet.spritesheetPath, etag: pet.etag, bytes: pet.bytes, filename: `${basename(pet.path)}.webp` };
  }
}

export const petLimits = { maxManifestBytes, maxSpritesheetBytes };
export { readWebpDimensions };
