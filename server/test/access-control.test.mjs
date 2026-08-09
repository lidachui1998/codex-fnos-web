import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isAuthorized,
  isSameOriginRequest,
  loadAccessControl,
  setAccessPassword,
  setSessionCookie,
  validatePassword,
  verifyAccessPassword,
} from "../lib/access-control.mjs";

test("first run stores a scrypt password record without saving the password", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-fnos-auth-"));
  try {
    const access = loadAccessControl(join(root, "secrets", "access-token"));
    assert.equal(access.setupRequired, true);
    assert.throws(() => validatePassword("short"), /至少需要 8 个字符/);

    setAccessPassword(access, "correct-horse-battery");

    assert.equal(access.setupRequired, false);
    assert.equal(verifyAccessPassword(access, "correct-horse-battery"), true);
    assert.equal(verifyAccessPassword(access, "wrong-password"), false);
    const stored = await readFile(access.passwordPath, "utf8");
    assert.equal(stored.includes("correct-horse-battery"), false);

    const reloaded = loadAccessControl(join(root, "secrets", "access-token"));
    assert.equal(reloaded.setupRequired, false);
    assert.equal(verifyAccessPassword(reloaded, "correct-horse-battery"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser cookie and legacy bearer token both authorize requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-fnos-cookie-"));
  try {
    const access = loadAccessControl(join(root, "secrets", "access-token"));
    const req = { headers: {}, socket: {} };
    const headers = new Map();
    setSessionCookie(req, { setHeader: (name, value) => headers.set(name, value) }, access);
    const setCookie = headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Secure/);
    assert.match(setCookie, /Max-Age=2592000/);

    const cookie = setCookie.split(";")[0];
    assert.equal(isAuthorized({ headers: { cookie } }, access), true);
    assert.equal(isAuthorized({ headers: { cookie: "codex_fnos_session=wrong" } }, access), false);
    assert.equal(isAuthorized({ headers: { authorization: `Bearer ${access.token}` } }, access), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTPS iframe sessions use a cross-site compatible secure cookie", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-fnos-https-cookie-"));
  try {
    const access = loadAccessControl(join(root, "secrets", "access-token"));
    const req = { headers: { "x-forwarded-proto": "https" }, socket: {} };
    const headers = new Map();
    setSessionCookie(req, { setHeader: (name, value) => headers.set(name, value) }, access);
    const setCookie = headers.get("set-cookie");
    assert.match(setCookie, /SameSite=None/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser password requests must come from the current origin", () => {
  const request = {
    headers: { host: "nas.local:19090", origin: "http://nas.local:19090" },
    socket: {},
  };
  assert.equal(isSameOriginRequest(request), true);
  assert.equal(isSameOriginRequest({ ...request, headers: { ...request.headers, origin: "https://example.com" } }), false);
  assert.equal(isSameOriginRequest({ headers: { host: "nas.local:19090" }, socket: {} }), true);
});

test("accepts fnOS mobile shells and reverse proxy forwarding without allowing unrelated sites", () => {
  const proxiedRequest = {
    headers: {
      host: "127.0.0.1:19090",
      "x-forwarded-host": "nas.local:5667",
      "x-forwarded-proto": "https",
      origin: "https://nas.local:5667",
    },
    socket: {},
  };
  assert.equal(isSameOriginRequest(proxiedRequest), true);
  assert.equal(
    isSameOriginRequest({
      headers: { host: "nas.local:19090", origin: "https://nas.local:7443" },
      socket: {},
    }),
    true,
  );
  assert.equal(
    isSameOriginRequest({
      headers: {
        host: "com-lidachui-codexweb.user.fnos.net",
        origin: "https://user.fnos.net",
      },
      socket: {},
    }),
    true,
  );
  assert.equal(
    isSameOriginRequest({
      headers: {
        host: "nas.local:19090",
        origin: "null",
        referer: "https://nas.local:5667/desktop/",
      },
      socket: {},
    }),
    true,
  );
  assert.equal(isSameOriginRequest({ headers: { host: "nas.local:19090", origin: "null" }, socket: {} }), false);
  assert.equal(
    isSameOriginRequest({
      headers: { host: "nas.local:19090", origin: "https://nas.local.attacker.example" },
      socket: {},
    }),
    false,
  );
});
