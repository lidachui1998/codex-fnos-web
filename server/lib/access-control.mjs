import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SESSION_COOKIE_NAME = "codex_fnos_session";
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function safeEqual(left, right) {
  const received = Buffer.from(left);
  const wanted = Buffer.from(right);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function readCookies(req) {
  const result = new Map();
  for (const part of String(req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) result.set(name, value);
  }
  return result;
}

function passwordHash(password, salt) {
  return scryptSync(password, salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
}

function readPasswordRecord(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.version !== 1 || typeof value.salt !== "string" || typeof value.hash !== "string") {
      throw new Error("访问密码文件格式无效");
    }
    return value;
  } catch (error) {
    throw new Error(`无法读取访问密码：${error.message}`);
  }
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.trim().length === 0) {
    throw Object.assign(new Error("请输入访问密码"), { status: 400 });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw Object.assign(new Error(`访问密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符`), { status: 400 });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw Object.assign(new Error(`访问密码不能超过 ${PASSWORD_MAX_LENGTH} 个字符`), { status: 400 });
  }
}

export function loadAccessControl(tokenPath, passwordPath = join(dirname(tokenPath), "access-password.json")) {
  const configured = process.env.APP_ACCESS_TOKEN?.trim();
  if (configured && configured.length < 16) throw new Error("APP_ACCESS_TOKEN 至少需要 16 个字符");

  mkdirSync(dirname(tokenPath), { recursive: true });
  let generated = false;
  if (!configured && !existsSync(tokenPath)) {
    writeFileSync(tokenPath, `${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
    generated = true;
  }
  if (!configured) {
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      // Windows development environments may not expose POSIX modes.
    }
  }

  const token = configured || readFileSync(tokenPath, "utf8").trim();
  if (token.length < 16) throw new Error("访问令牌文件内容无效");
  const passwordRecord = readPasswordRecord(passwordPath);
  return {
    token,
    generated,
    tokenPath: configured ? null : tokenPath,
    passwordPath,
    passwordRecord,
    sessionToken: createHmac("sha256", token).update("codex-fnos-browser-session-v1").digest("base64url"),
    get setupRequired() {
      return this.passwordRecord === null;
    },
  };
}

export function setAccessPassword(access, password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const record = {
    version: 1,
    salt: salt.toString("base64url"),
    hash: passwordHash(password, salt).toString("base64url"),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(access.passwordPath), { recursive: true });
  const tempPath = `${access.passwordPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, access.passwordPath);
  try {
    chmodSync(access.passwordPath, 0o600);
  } catch {
    // Windows development environments may not expose POSIX modes.
  }
  access.passwordRecord = record;
}

export function verifyAccessPassword(access, password) {
  if (!access.passwordRecord || typeof password !== "string") return false;
  const salt = Buffer.from(access.passwordRecord.salt, "base64url");
  const expected = Buffer.from(access.passwordRecord.hash, "base64url");
  return safeEqual(passwordHash(password, salt), expected);
}

export function isAuthorized(req, access) {
  const expectedToken = typeof access === "string" ? access : access.token;
  const header = req.headers.authorization || req.headers["x-fnos-token"] || "";
  const bearer = String(header).replace(/^Bearer\s+/i, "");
  if (bearer && safeEqual(bearer, expectedToken)) return true;
  if (typeof access === "string") return false;
  const cookie = readCookies(req).get(SESSION_COOKIE_NAME) || "";
  return cookie !== "" && safeEqual(cookie, access.sessionToken);
}

function requestUsesHttps(req) {
  return Boolean(req.socket?.encrypted) || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function firstForwardedValue(value) {
  return String(value || "").split(",")[0].trim();
}

function requestHosts(req) {
  return [firstForwardedValue(req.headers["x-forwarded-host"]), firstForwardedValue(req.headers.host)].filter(Boolean);
}

function isTrustedFnosOrigin(url, req) {
  if (!["http:", "https:"].includes(url.protocol)) return false;
  for (const host of requestHosts(req)) {
    try {
      const requestHost = new URL(`http://${host}`).hostname;
      if (url.hostname === requestHost) return true;
      if (url.hostname.endsWith(".fnos.net") && requestHost.endsWith(`.${url.hostname}`)) return true;
    } catch {
      // Ignore malformed forwarded hosts and continue checking the direct host.
    }
  }
  return false;
}

export function setSessionCookie(req, res, access) {
  const usesHttps = requestUsesHttps(req);
  const secure = usesHttps ? "; Secure" : "";
  const sameSite = usesHttps ? "None" : "Lax";
  res.setHeader(
    "set-cookie",
    `${SESSION_COOKIE_NAME}=${access.sessionToken}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
  );
}

export function clearSessionCookie(req, res) {
  const usesHttps = requestUsesHttps(req);
  const secure = usesHttps ? "; Secure" : "";
  const sameSite = usesHttps ? "None" : "Lax";
  res.setHeader(
    "set-cookie",
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`,
  );
}

export function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    if (origin === "null") {
      const referer = req.headers.referer;
      return Boolean(referer) && isTrustedFnosOrigin(new URL(referer), req);
    }
    const originUrl = new URL(origin);
    const forwardedProto = firstForwardedValue(req.headers["x-forwarded-proto"]);
    const protocol = forwardedProto || (req.socket?.encrypted ? "https" : "http");
    if (requestHosts(req).some((host) => originUrl.origin === `${protocol}://${host}`)) return true;
    return isTrustedFnosOrigin(originUrl, req);
  } catch {
    return false;
  }
}
