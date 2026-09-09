import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeService } from "../runtime-service.mjs";
import { HostConnection } from "../../src/host-connection.ts";
import { toolDetail, toolFailure } from "../../src/tool-diagnostics.ts";

function bridgeFixture() {
  const bridge = new EventEmitter();
  bridge.activeTurns = new Set();
  bridge.status = "ready";
  bridge.snapshot = () => ({ status: bridge.status, error: null, pid: 42 });
  bridge.hasActiveTurns = () => bridge.activeTurns.size > 0;
  bridge.state = (status) => { bridge.status = status; bridge.emit("event", { kind: "bridge_state", state: bridge.snapshot() }); };
  return bridge;
}

test("manual restart refuses active tasks unless interruption is explicit", async () => {
  const bridge = bridgeFixture();
  let calls = 0;
  bridge.restart = async () => { calls += 1; };
  bridge.activeTurns.add("thread:turn");
  const runtime = new RuntimeService(bridge);
  await assert.rejects(runtime.restart(), { status: 409 });
  assert.equal(calls, 0);
  await runtime.restart({ force: true });
  assert.equal(calls, 1);
  runtime.close();
});

test("failed startup recovers with a bounded retry budget, without crash loops", async () => {
  const bridge = bridgeFixture();
  let calls = 0;
  bridge.restart = async () => { calls += 1; bridge.state("error"); throw new Error("offline"); };
  const runtime = new RuntimeService(bridge, { retryDelays: [1, 1, 1] });
  bridge.state("error");
  for (let i = 0; i < 100 && calls < 3; i += 1) await delay(5);
  await delay(10);
  assert.equal(calls, 3);
  assert.equal(runtime.snapshot().nextRetryAt, null);
  runtime.close();
});

test("shutdown cancels queued recovery", async () => {
  const bridge = bridgeFixture();
  let calls = 0;
  bridge.restart = async () => { calls += 1; };
  const runtime = new RuntimeService(bridge, { retryDelays: [10] });
  bridge.state("error"); runtime.close();
  await delay(20);
  assert.equal(calls, 0);
});

test("MCP inventory follows pagination without exposing configuration or calling tools", async () => {
  const bridge = bridgeFixture();
  const calls = [];
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [], nextCursor: null } : { data: [{ name: "search", authStatus: "unsupported", tools: { search: { name: "search", inputSchema: { secret: "hidden" } } }, resources: [], resourceTemplates: [] }], nextCursor: "page2" };
  };
  const runtime = new RuntimeService(bridge);
  assert.deepEqual(await runtime.mcpStatus("thread"), { data: [{ name: "search", authStatus: "unsupported", tools: ["search"], resourceCount: 0, templateCount: 0 }], truncated: false });
  assert.deepEqual(calls.map((x) => x.params), [{ limit: 100, threadId: "thread" }, { limit: 100, cursor: "page2", threadId: "thread" }]);
  assert.ok(calls.every((x) => x.method === "mcpServerStatus/list"));
  runtime.close();
});

test("MCP reload uses the official config reload without restarting active turns", async () => {
  const bridge = bridgeFixture();
  bridge.activeTurns.add("thread:turn");
  bridge.request = async (method) => { assert.equal(method, "config/mcpServer/reload"); return {}; };
  bridge.restart = () => assert.fail("must not restart");
  const runtime = new RuntimeService(bridge);
  await runtime.reloadMcp();
  assert.equal(bridge.activeTurns.size, 1);
  runtime.close();
});

test("MCP errors remain visible when the failed call also has arguments", () => {
  const item = { type: "mcpToolCall", tool: "read_mcp_resource", status: "failed", arguments: { server: "searxng", uri: "searxng://search" }, error: { message: "resources/read failed: unknown MCP server 'searxng'" }, result: null };
  assert.match(toolFailure(item).hint, /没有加载/);
  assert.deepEqual(JSON.parse(toolDetail(item)), { error: item.error, arguments: item.arguments });
  assert.equal(toolFailure({ ...item, status: "completed", error: null }), null);
  assert.match(toolFailure({ ...item, error: { message: "MCP error -32601: Method not found" } }).hint, /不支持此资源操作/);
});

test("timed out host handshakes never send delayed file navigation; reconnect uses a fresh module", async () => {
  let release;
  let calls = 0;
  const generations = [];
  const firstReady = new Promise((resolve) => { release = resolve; });
  const connection = new HostConnection(async (generation) => {
    generations.push(generation);
    return { isStandaloneWeb: false, ready: () => generation === 1 ? firstReady : Promise.resolve() };
  }, 10);
  await assert.rejects(connection.run(async () => { calls += 1; }), /建立连接超时/);
  release(); await delay(1);
  assert.equal(calls, 0);
  await connection.reconnect();
  await connection.run(async () => { calls += 1; });
  assert.deepEqual(generations, [1, 2]);
  assert.equal(calls, 1);
});

test("missing navigation acknowledgements do not replay operations", async () => {
  const connection = new HostConnection(async () => ({ isStandaloneWeb: false, ready: async () => {} }), 10);
  let calls = 0;
  await assert.rejects(connection.run(() => { calls += 1; return new Promise(() => {}); }), /已发送打开请求/);
  await delay(15);
  assert.equal(calls, 1);
});

test("standalone pages fail immediately and reconnect attempts are bounded", async () => {
  const connection = new HostConnection(async () => ({ isStandaloneWeb: true, ready: async () => assert.fail("no host") }));
  await assert.rejects(connection.connect(), /独立网页/);
  await assert.rejects(connection.reconnect(), /独立网页/);
  await assert.rejects(connection.reconnect(), /独立网页/);
  await assert.rejects(connection.reconnect(), /3 次/);
});
