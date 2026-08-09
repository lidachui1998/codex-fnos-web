import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const maxBackgroundBytes = 8 * 1024 * 1024;

function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export class AppearanceService {
  constructor(dataDir) {
    this.path = join(dataDir, "appearance", "background.image");
    this.metaPath = join(dataDir, "appearance", "background.json");
  }

  status() {
    return { hasBackground: existsSync(this.path), updatedAt: existsSync(this.path) ? Math.floor(statSync(this.path).mtimeMs) : null };
  }

  save(buffer) {
    if (!buffer.length) throw Object.assign(new Error("请选择背景图片"), { status: 400 });
    if (buffer.length > maxBackgroundBytes) throw Object.assign(new Error("背景图片不能超过 8 MB"), { status: 413 });
    const contentType = imageType(buffer);
    if (!contentType) throw Object.assign(new Error("只支持 PNG、JPEG 或 WebP 图片"), { status: 415 });
    mkdirSync(dirname(this.path), { recursive: true });
    const next = `${this.path}.tmp`;
    writeFileSync(next, buffer, { mode: 0o600 });
    renameSync(next, this.path);
    writeFileSync(this.metaPath, `${JSON.stringify({ contentType })}\n`, { mode: 0o600 });
    return this.status();
  }

  remove() {
    rmSync(this.path, { force: true });
    rmSync(this.metaPath, { force: true });
    return this.status();
  }

  send(res) {
    if (!existsSync(this.path)) return false;
    let contentType = "image/jpeg";
    try { contentType = JSON.parse(readFileSync(this.metaPath, "utf8")).contentType || contentType; } catch { /* use fallback */ }
    const stat = statSync(this.path);
    res.writeHead(200, {
      "cache-control": "private, max-age=300",
      "content-length": stat.size,
      "content-type": contentType,
      "x-content-type-options": "nosniff",
    });
    createReadStream(this.path).pipe(res);
    return true;
  }
}
