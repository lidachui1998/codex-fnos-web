import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(body);
}

export function sendError(res, status, message, details) {
  sendJson(res, status, { error: { message, details: details ?? null } });
}

export async function readJson(req, limit = 1024 * 1024) {
  const body = await readBuffer(req, limit);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    const error = new Error("JSON 格式无效");
    error.status = 400;
    throw error;
  }
}

export async function readBuffer(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("请求内容过大");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function serveStatic(res, distDir, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\\|\/|$))+/, "");
  let filePath = join(distDir, safePath);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(distDir, "index.html");
  }
  if (!existsSync(filePath)) return false;
  const stat = statSync(filePath);
  res.writeHead(200, {
    "cache-control": filePath.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "content-length": stat.size,
    "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

export function route(method, pathname, pattern) {
  if (method !== pattern.method) return null;
  const match = pathname.match(pattern.path);
  return match?.groups ?? null;
}
