import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const rootDir = resolve(import.meta.dirname, "..");
const appRoot = resolve(process.env.E2E_APP_ROOT || rootDir);
const serverEntry = process.env.E2E_SERVER_ENTRY || "server/index.mjs";
const nodeBin = process.execPath;
const codexBin = process.env.CODEX_BIN;
if (!codexBin) throw new Error("CODEX_BIN is required for the app-server smoke test");
const assistantText = "第三方 API 链路正常\n\n**Markdown 已生效**\n\n- 模型切换\n- 附件输入\n- [打开 src/index.js](src/index.js:1)\n\n```js\nconsole.log('fnOS');\n```";
const testImagePng = await readFile(join(rootDir, "assets", "app-icon.png"));
const testImageDataUrl = `data:image/png;base64,${testImagePng.toString("base64")}`;

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function createMockProvider(modelRequests) {
  const models = [
    { id: "mock-coder" },
    { id: "mock-coder-fast" },
    ...Array.from({ length: 40 }, (_, index) => ({ id: `mock-model-${String(index + 1).padStart(2, "0")}` })),
  ];
  return createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      modelRequests.push(body.model);
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chat-test",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, { id: "chat-test", model: body.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      writeSse(res, { id: "chat-test", model: body.model, choices: [{ index: 0, delta: { content: assistantText }, finish_reason: null }] });
      writeSse(res, { id: "chat-test", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      writeSse(res, { id: "chat-test", model: body.model, choices: [], usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 } });
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

async function waitForAuthStatus(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.ok) return response.json();
    } catch {
      // Service may still be starting.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for auth status");
}

async function waitForBridge(baseUrl, cookie, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`, { headers: { cookie } });
      const body = await response.json();
      last = body.bridge;
      if (body.bridge?.status === "ready") return body;
      if (body.bridge?.status === "error") throw new Error(body.bridge.error);
    } catch (error) {
      last = error;
    }
    await delay(200);
  }
  throw new Error(`Bridge did not become ready: ${JSON.stringify(last)}`);
}

async function request(baseUrl, cookie, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function collectUntilTurnCompleted(baseUrl, cookie, threadId, action) {
  const controller = new AbortController();
  const events = [];
  let buffer = "";
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolveEvent, rejectEvent) => {
    resolveCompleted = resolveEvent;
    rejectCompleted = rejectEvent;
  });
  const readerTask = fetch(`${baseUrl}/events`, {
    headers: { cookie },
    signal: controller.signal,
  }).then(async (response) => {
    assert.equal(response.status, 200);
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
        if (!data) continue;
        const event = JSON.parse(data.slice(5).trim());
        events.push(event);
        if (event.method === "turn/completed" && event.params?.threadId === threadId) {
          resolveCompleted(event);
          return;
        }
      }
    }
  }).catch((error) => {
    if (!controller.signal.aborted) rejectCompleted(error);
  });
  await delay(100);
  await action();
  await Promise.race([
    completed,
    delay(30_000).then(() => { throw new Error("Timed out waiting for turn/completed"); }),
  ]);
  controller.abort();
  await readerTask.catch(() => {});
  return events;
}

const tempRoot = await mkdtemp(join(tmpdir(), "codex-fnos-e2e-"));
const dataDir = join(tempRoot, "data");
const workspaceRoot = join(tempRoot, "workspaces");
await mkdir(workspaceRoot, { recursive: true });
const e2eSkillPath = join(dataDir, "codex-home", "skills", "e2e-review", "SKILL.md");
await mkdir(join(dataDir, "codex-home", "skills", "e2e-review"), { recursive: true });
await writeFile(e2eSkillPath, "---\nname: e2e-review\ndescription: Review the current project in E2E tests.\n---\n\n# E2E Review\n\nReview the selected project.\n", "utf8");
const modelRequests = [];
const mockServer = createMockProvider(modelRequests);
const mockPort = await listen(mockServer);
const appPortProbe = createServer();
const appPort = await listen(appPortProbe);
await new Promise((resolveClose) => appPortProbe.close(resolveClose));
const appBaseUrl = `http://127.0.0.1:${appPort}`;
const logs = { stdout: "", stderr: "" };

function startApp() {
  const child = spawn(nodeBin, [serverEntry], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: process.env.E2E_HOST || "127.0.0.1",
      DATA_DIR: dataDir,
      WORKSPACE_ROOTS: workspaceRoot,
      CODEX_BIN: codexBin,
      CODEX_BUNDLED_VERSION: "0.147.0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { logs.stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { logs.stderr += chunk.toString("utf8"); });
  return child;
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
}

let app = startApp();

try {
  const initialStatus = await waitForAuthStatus(appBaseUrl);
  assert.deepEqual(initialStatus, { authenticated: false, setupRequired: true });
  const unauthorized = await fetch(`${appBaseUrl}/api/bootstrap`);
  assert.equal(unauthorized.status, 401);

  const setup = await fetch(`${appBaseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "e2e-access-password" }),
  });
  assert.equal(setup.status, 200);
  const setupCookie = setup.headers.get("set-cookie")?.split(";")[0];
  assert.ok(setupCookie);
  const authenticatedStatus = await fetch(`${appBaseUrl}/api/auth/status`, { headers: { cookie: setupCookie } });
  assert.deepEqual(await authenticatedStatus.json(), { authenticated: true, setupRequired: false });

  const wrongLogin = await fetch(`${appBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" }),
  });
  assert.equal(wrongLogin.status, 401);
  const login = await fetch(`${appBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "null" },
    body: JSON.stringify({ password: "e2e-access-password" }),
  });
  assert.equal(login.status, 200);
  const loginCookie = login.headers.get("set-cookie");
  assert.match(loginCookie || "", /SameSite=Lax/);
  const cookie = loginCookie?.split(";")[0];
  assert.ok(cookie);
  await waitForBridge(appBaseUrl, cookie);

  const proxyResult = await request(appBaseUrl, cookie, "/api/proxies", {
    method: "POST",
    body: JSON.stringify({
      name: "Combined Proxy",
      httpUrl: "http://127.0.0.1:48080",
      httpsUrl: "http://127.0.0.1:48443",
      socks5Url: "socks5://127.0.0.1:41080",
      noProxy: "127.0.0.1,localhost",
    }),
  });
  assert.equal(proxyResult.proxy.httpUrlHint, "http://127.0.0.1:48080");
  assert.equal(proxyResult.proxy.httpsUrlHint, "http://127.0.0.1:48443");
  assert.equal(proxyResult.proxy.socks5UrlHint, "socks5://127.0.0.1:41080");
  await request(appBaseUrl, cookie, "/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ defaultProxyId: proxyResult.proxy.id }),
  });
  const backgroundUpload = await fetch(`${appBaseUrl}/api/appearance/background`, {
    method: "POST",
    headers: { cookie, "content-type": "image/png" },
    body: testImagePng,
  });
  assert.equal(backgroundUpload.status, 200);
  const backgroundStatus = await backgroundUpload.json();
  assert.equal(backgroundStatus.hasBackground, true);
  assert.equal(typeof backgroundStatus.updatedAt, "number");
  const backgroundDownload = await fetch(`${appBaseUrl}/api/appearance/background`, { headers: { cookie } });
  assert.equal(backgroundDownload.headers.get("content-type"), "image/png");
  await delay(800);
  await waitForBridge(appBaseUrl, cookie);

  const previewModels = await request(appBaseUrl, cookie, "/api/providers/models", {
    method: "POST",
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      protocol: "chat_completions",
      apiKey: "test-key",
      headers: {},
      proxyMode: "direct",
    }),
  });
  assert.equal(previewModels.data.length, 42);
  assert.deepEqual(previewModels.data.slice(0, 2).map((item) => item.model), ["mock-coder", "mock-coder-fast"]);
  assert.equal(previewModels.source, `http://127.0.0.1:${mockPort}/v1/models`);

  const providerResult = await request(appBaseUrl, cookie, "/api/providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Mock Chat Provider",
      protocol: "chat_completions",
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      model: "mock-coder",
      apiKey: "test-key",
      proxyMode: "direct",
    }),
  });
  assert.equal(providerResult.provider.proxyMode, "direct");
  await delay(800);
  await waitForBridge(appBaseUrl, cookie);
  const modelList = await request(appBaseUrl, cookie, `/api/models?providerId=${providerResult.provider.id}`);
  assert.equal(modelList.data.length, 42);
  assert.deepEqual(modelList.data.slice(0, 2).map((item) => item.model), ["mock-coder", "mock-coder-fast"]);
  const providerTest = await request(appBaseUrl, cookie, `/api/providers/${providerResult.provider.id}/test`, { method: "POST", body: "{}" });
  assert.equal(providerTest.ok, true);

  const projectResult = await request(appBaseUrl, cookie, "/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: "E2E Project",
      path: join(workspaceRoot, "e2e-project"),
      defaultProviderId: providerResult.provider.id,
      create: true,
    }),
  });
  await mkdir(join(projectResult.project.path, "src"), { recursive: true });
  await writeFile(join(projectResult.project.path, "src", "index.js"), "export const hello = 'fnOS';\n", "utf8");
  await writeFile(join(projectResult.project.path, "README.md"), "# Codex 飞牛项目\n\n> Markdown 项目预览\n\n- 支持 **GFM** 样式\n- 支持表格与代码块\n\n| 功能 | 状态 |\n| --- | --- |\n| 图片预览 | 完成 |\n| Diff 着色 | 完成 |\n\n```js\nconsole.log('fnOS');\n```\n", "utf8");
  await writeFile(join(projectResult.project.path, "preview.png"), testImagePng);
  const projectFiles = await request(appBaseUrl, cookie, `/api/projects/${projectResult.project.id}/files?path=src`);
  assert.equal(projectFiles.entries[0].name, "index.js");
  const projectFile = await request(appBaseUrl, cookie, `/api/projects/${projectResult.project.id}/file?path=src%2Findex.js`);
  assert.equal(projectFile.content, "export const hello = 'fnOS';\n");
  const absoluteProjectFile = await request(appBaseUrl, cookie, `/api/projects/${projectResult.project.id}/file?path=${encodeURIComponent(`${join(projectResult.project.path, "src", "index.js")}:1`)}`);
  assert.equal(absoluteProjectFile.path, "src/index.js");
  const listedSkills = await request(appBaseUrl, cookie, `/api/projects/${projectResult.project.id}/skills?reload=1`);
  const e2eSkill = listedSkills.skills.find((skill) => skill.name === "e2e-review");
  assert.ok(e2eSkill?.enabled, JSON.stringify(listedSkills));
  const skillDetail = await request(appBaseUrl, cookie, `/api/projects/${projectResult.project.id}/skills/detail?path=${encodeURIComponent(e2eSkill.path)}`);
  assert.match(skillDetail.content, /E2E Review/);
  const disabledSkills = await request(appBaseUrl, cookie, `/api/projects/${projectResult.project.id}/skills`, { method: "PATCH", body: JSON.stringify({ path: e2eSkill.path, enabled: false }) });
  assert.equal(disabledSkills.skills.find((skill) => skill.path === e2eSkill.path)?.enabled, false);
  const enabledSkills = await request(appBaseUrl, cookie, `/api/projects/${projectResult.project.id}/skills`, { method: "PATCH", body: JSON.stringify({ path: e2eSkill.path, enabled: true }) });
  assert.equal(enabledSkills.skills.find((skill) => skill.path === e2eSkill.path)?.enabled, true);
  if (process.env.E2E_SERVE_UI === "1") {
    spawnSync("git", ["init"], { cwd: projectResult.project.path, windowsHide: true });
    spawnSync("git", ["add", "src/index.js"], { cwd: projectResult.project.path, windowsHide: true });
    await writeFile(join(projectResult.project.path, "src", "index.js"), "export const hello = 'fnOS';\nexport const changed = true;\n", "utf8");
  }

  await request(appBaseUrl, cookie, "/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ approvalPolicy: "never", theme: "dark", backgroundEnabled: true, backgroundOpacity: 0.25 }),
  });
  await delay(800);
  await waitForBridge(appBaseUrl, cookie);
  const threadResult = await request(appBaseUrl, cookie, "/api/threads", {
    method: "POST",
    body: JSON.stringify({ projectId: projectResult.project.id, approvalPolicy: "never" }),
  });
  assert.equal(threadResult.approvalPolicy, "never");
  const threadId = threadResult.thread.id;
  await request(appBaseUrl, cookie, `/api/threads/${threadId}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ model: "mock-coder-fast", effort: "high", approvalPolicy: "on-request" }),
  });
  const events = await collectUntilTurnCompleted(appBaseUrl, cookie, threadId, () => request(appBaseUrl, cookie, `/api/threads/${threadId}/turns`, {
    method: "POST",
    body: JSON.stringify({ text: "say hello", projectId: projectResult.project.id, effort: "high", approvalPolicy: "on-request", skills: [{ name: e2eSkill.name, path: e2eSkill.path }], attachments: [{ kind: "text", name: "note.md", content: "# attached" }, { kind: "image", name: "app-icon.png", dataUrl: testImageDataUrl }] }),
  }));
  assert(events.some((event) => event.method === "item/agentMessage/delta" && event.params?.delta?.includes("第三方 API")));

  const threadRead = await request(appBaseUrl, cookie, `/api/threads/${threadId}`);
  const agentText = threadRead.thread.turns.flatMap((turn) => turn.items)
    .find((item) => item.type === "agentMessage")?.text;
  const userImages = threadRead.thread.turns.flatMap((turn) => turn.items)
    .find((item) => item.type === "userMessage")?.content?.filter((part) => part.type === "image") ?? [];
  assert.equal(userImages[0]?.url, testImageDataUrl);
  assert.equal(agentText, assistantText);
  assert.equal(modelRequests.at(-1), "mock-coder-fast");
  const resumedThread = await request(appBaseUrl, cookie, `/api/threads/${threadId}/resume`, { method: "POST", body: "{}" });
  assert.equal(resumedThread.model, "mock-coder-fast");
  assert.equal(resumedThread.reasoningEffort, "high");
  assert.equal(resumedThread.approvalPolicy, "on-request");
  await delay(1200);
  const persistedThreads = await request(appBaseUrl, cookie, `/api/threads?cwd=${encodeURIComponent(projectResult.project.path)}`);
  const allPersistedThreads = await request(appBaseUrl, cookie, "/api/threads");
  assert.ok(persistedThreads.data.some((thread) => thread.id === threadId), JSON.stringify({
    message: "new thread must remain visible in thread/list",
    threadId,
    projectPath: projectResult.project.path,
    threadCwd: threadRead.thread.cwd,
    threadEphemeral: threadRead.thread.ephemeral,
    threadSource: threadRead.thread.source,
    threadModelProvider: threadRead.thread.modelProvider,
    scopedThreads: persistedThreads.data.map((thread) => ({ id: thread.id, cwd: thread.cwd, source: thread.source })),
    allThreads: allPersistedThreads.data.map((thread) => ({ id: thread.id, cwd: thread.cwd, source: thread.source })),
  }));
  const removablePath = join(workspaceRoot, "remove-from-list-only");
  const removable = await request(appBaseUrl, cookie, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Remove only", path: removablePath, create: true }),
  });
  await request(appBaseUrl, cookie, `/api/projects/${removable.project.id}`, { method: "DELETE" });
  assert.equal((await stat(removablePath)).isDirectory(), true, "removing project must preserve the NAS directory");

  await stopApp(app);
  app = startApp();
  const restartedStatus = await waitForAuthStatus(appBaseUrl);
  assert.deepEqual(restartedStatus, { authenticated: false, setupRequired: false });
  const restartedLogin = await fetch(`${appBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "e2e-access-password" }),
  });
  assert.equal(restartedLogin.status, 200);
  const restartedCookie = restartedLogin.headers.get("set-cookie")?.split(";")[0];
  assert.ok(restartedCookie);
  await waitForBridge(appBaseUrl, restartedCookie);
  const restartedThreads = await request(appBaseUrl, restartedCookie, `/api/threads?cwd=${encodeURIComponent(projectResult.project.path)}`);
  assert.ok(restartedThreads.data.some((thread) => thread.id === threadId), "thread must remain visible after an app restart");
  const restartedResume = await request(appBaseUrl, restartedCookie, `/api/threads/${threadId}/resume`, { method: "POST", body: "{}" });
  assert.equal(restartedResume.model, "mock-coder-fast", "selected model must survive an app restart");
  assert.equal(restartedResume.reasoningEffort, "high", "reasoning effort must survive an app restart");
  assert.equal(restartedResume.approvalPolicy, "on-request", "per-thread approval policy must survive an app restart");
  let threadDelete = false;
  if (process.env.E2E_SERVE_UI !== "1") {
    await request(appBaseUrl, restartedCookie, `/api/threads/${threadId}`, { method: "DELETE" });
    const threadsAfterDelete = await request(appBaseUrl, restartedCookie, `/api/threads?cwd=${encodeURIComponent(projectResult.project.path)}`);
    assert.equal(threadsAfterDelete.data.some((thread) => thread.id === threadId), false, "deleted thread must leave the active history list");
    threadDelete = true;
  }

  console.log(JSON.stringify({
    ok: true,
    appBaseUrl,
    bridge: "ready",
    providerProtocol: "chat_completions",
    combinedProxy: true,
    providerProxyMode: providerResult.provider.proxyMode,
    providerTest: true,
    switchedModel: modelRequests.at(-1),
    reasoningEffort: resumedThread.reasoningEffort,
    approvalPolicy: resumedThread.approvalPolicy,
    skills: true,
    workspaceLinks: true,
    attachmentInput: true,
    imageHistory: true,
    backgroundImage: true,
    workspaceFiles: true,
    threadId,
    streamedText: agentText,
    eventCount: events.length,
    persistedHistory: true,
    historyAfterRestart: true,
    threadDelete,
  }, null, 2));
  if (process.env.E2E_SERVE_UI === "1") {
    console.log("UI fixture ready; login password: e2e-access-password");
    await new Promise((resolveStop) => {
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
  }
} catch (error) {
  console.error(logs.stdout);
  console.error(logs.stderr);
  throw error;
} finally {
  await stopApp(app);
  await new Promise((resolveClose) => mockServer.close(resolveClose));
  let cleanupError;
  if (process.env.E2E_KEEP_TEMP === "1") {
    console.error(`E2E temporary data retained at ${tempRoot}`);
  } else {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
        cleanupError = null;
        break;
      } catch (error) {
        cleanupError = error;
        if (error.code !== "EBUSY" || attempt === 5) break;
        await delay(200 * (attempt + 1));
      }
    }
  }
  if (cleanupError) console.error(`Temporary cleanup warning: ${cleanupError.message}`);
}
