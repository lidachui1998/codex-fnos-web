import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { automaticJoinClientIdPrefix, SubagentJoinService } from "../subagent-join-service.mjs";

function stores() {
  return {
    getSettings: () => ({ approvalPolicy: "never", networkAccess: true, fnosInstructions: true }),
    getThreadPreferences: () => ({ projectId: "project-1", approvalPolicy: "never", networkAccess: true }),
    listProjects: () => [{ id: "project-1", path: "/vol1/project", instructions: "project rules" }],
  };
}

class MockBridge extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.descendantActive = true;
    this.parentActive = false;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return { data: [{ id: "child-1", status: { type: this.descendantActive ? "active" : "idle" } }] };
    }
    if (method === "thread/resume") {
      return { thread: { id: params.threadId, cwd: "/vol1/project", status: { type: this.parentActive ? "active" : "idle" } } };
    }
    if (method === "turn/start") return { turn: { id: "join-turn" } };
    throw new Error(`unexpected method ${method}`);
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

test("a completed parent waits for active descendants and resumes itself after they settle", async () => {
  const bridge = new MockBridge();
  const events = [];
  const service = new SubagentJoinService({ stores: stores(), bridge, onChanged: (event) => events.push(event), pollIntervalMs: 10, settleDelayMs: 0 });

  bridge.emit("event", {
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "root-1", turn: { id: "root-turn", status: "completed" } },
  });
  await waitFor(() => events.some((event) => event.status === "waiting"));
  assert.equal(service.snapshot("root-1")?.activeCount, 1);
  assert.equal(bridge.calls.some((call) => call.method === "turn/start"), false);

  bridge.descendantActive = false;
  await waitFor(() => bridge.calls.some((call) => call.method === "turn/start"));
  const start = bridge.calls.find((call) => call.method === "turn/start");
  assert.match(start.params.clientUserMessageId, new RegExp(`^${automaticJoinClientIdPrefix}`));
  assert.match(start.params.input[0].text, /读取并汇总它们的真实结果/);
  assert.deepEqual(start.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: ["/vol1/project"], networkAccess: true });
  assert.equal(service.snapshot("root-1"), null);
  assert.deepEqual(events.map((event) => event.status), ["waiting", "finalizing", "resumed"]);
  service.close();
});

test("a completed turn without active descendants does not create an automatic continuation", async () => {
  const bridge = new MockBridge();
  bridge.descendantActive = false;
  const service = new SubagentJoinService({ stores: stores(), bridge, pollIntervalMs: 10, settleDelayMs: 0 });
  const state = await service.ensure("root-2", "turn-2");
  assert.equal(state, null);
  assert.deepEqual(bridge.calls.map((call) => call.method), ["thread/list"]);
  service.close();
});

test("an already active parent is not given a competing automatic turn", async () => {
  const bridge = new MockBridge();
  const events = [];
  const service = new SubagentJoinService({ stores: stores(), bridge, onChanged: (event) => events.push(event), pollIntervalMs: 10, settleDelayMs: 0 });
  await service.ensure("root-3", "turn-3");
  bridge.descendantActive = false;
  bridge.parentActive = true;
  await waitFor(() => events.some((event) => event.status === "resumed"));
  assert.equal(bridge.calls.some((call) => call.method === "turn/start"), false);
  service.close();
});
