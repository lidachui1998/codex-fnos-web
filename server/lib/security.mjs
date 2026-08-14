import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadOrCreateMasterKey(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32), { mode: 0o600 });
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("本地密钥长度无效");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows development environments may not expose POSIX modes.
  }
  return key;
}

export function encryptSecret(value, key) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptSecret(value, key) {
  if (!value) return "";
  const packed = Buffer.from(value, "base64url");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function secretHint(value) {
  if (!value) return null;
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

export function createInternalToken() {
  return randomBytes(32).toString("base64url");
}

export function isInternalAuthorized(value, expected) {
  const received = Buffer.from(String(value ?? "").replace(/^Bearer\s+/i, ""));
  const wanted = Buffer.from(String(expected ?? ""));
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}
