import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../database.mjs";
import { OutboxService } from "../outbox-service.mjs";
import { Stores } from "../stores.mjs";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class Bridge extends EventEmitter {
  constructor(status = "ready") {
    super();
    this.status = status;
    this.thread = { id: "thread-1", turns: [{ id: "turn-running", status: "inProgress", items: [] }] };
    this.calls = [];
  }

  snapshot() {
    return { status: this.status };
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/read") return { thread: this.thread };
    if (method === "turn/start") return { turn: { id: "turn-outbox" } };
    if (method === "turn/steer") return { turnId: params.expectedTurnId };
    throw new Error(`Unexpected method: ${method}`);
  }
}

function fixture(bridge = new Bridge()) {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-outbox-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(join(root, "store.sqlite"));
  const stores = new Stores(db, Buffer.alloc(32, 5), [workspace]);
  stores.ensureCodexAccount();
  const project = stores.saveProject({ name: "Project", path: workspace, create: false });
  const joins = { ensure: async () => null, snapshot: () => null };
  const changed = [];
  const service = new OutboxService({
    stores,
    bridge,
    subagentJoins: joins,
    getAccountId: () => "primary",
    onChanged: (state) => changed.push(state),
    retryDelayMs: 20,
  });
  return {
    bridge,
    changed,
    project,
    service,
    stores,
    close() {
      service.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function enqueue(value) {
  return value.service.enqueue({
    threadId: "thread-1",
    projectId: value.project.id,
    displayPayload: { text: "继续完成", attachments: [], skills: [] },
    turnInput: [{ type: "text", text: "继续完成" }],
    approvalPolicy: "on-request",
    networkAccess: true,
    model: "gpt-test",
    effort: "high",
  });
}

test("queued messages persist while a turn is active and dispatch after it completes", async () => {
  const value = fixture();
  try {
    const message = enqueue(value);
    await pause(140);
    assert.deepEqual(value.service.list().map(({ id, status, text }) => ({ id, status, text })), [
      { id: message.id, status: "queued", text: "继续完成" },
    ]);
    assert.equal(value.bridge.calls.some((call) => call.method === "turn/start"), false);

    value.bridge.thread = { id: "thread-1", turns: [{ id: "turn-running", status: "completed", items: [] }] };
    value.bridge.emit("event", {
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: value.bridge.thread.turns[0] },
    });
    await pause(500);

    const start = value.bridge.calls.find((call) => call.method === "turn/start");
    assert.deepEqual(start.params, {
      threadId: "thread-1",
      clientUserMessageId: `fnos-outbox-${message.id}`,
      input: [{ type: "text", text: "继续完成" }],
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [value.project.path], networkAccess: true },
      model: "gpt-test",
      effort: "high",
    });
    assert.deepEqual(value.service.list(), []);
  } finally {
    value.close();
  }
});

test("a queued message can be steered exactly once", async () => {
  const value = fixture();
  try {
    const message = enqueue(value);
    const result = await value.service.steer(message.id, "turn-running");
    assert.deepEqual(result, { turnId: "turn-running" });
    assert.deepEqual(value.bridge.calls.find((call) => call.method === "turn/steer").params, {
      threadId: "thread-1",
      clientUserMessageId: `fnos-outbox-${message.id}`,
      input: [{ type: "text", text: "继续完成" }],
      expectedTurnId: "turn-running",
    });
    assert.deepEqual(value.service.list(), []);
    await assert.rejects(() => value.service.steer(message.id, "turn-running"), /已被发送/);
  } finally {
    value.close();
  }
});

test("queued messages survive service recreation", () => {
  const bridge = new Bridge("starting");
  const value = fixture(bridge);
  try {
    const message = enqueue(value);
    value.service.close();
    const recreated = new OutboxService({
      stores: value.stores,
      bridge,
      subagentJoins: { ensure: async () => null, snapshot: () => null },
      getAccountId: () => "primary",
    });
    try {
      assert.deepEqual(recreated.list().map(({ id, status }) => ({ id, status })), [{ id: message.id, status: "queued" }]);
    } finally {
      recreated.close();
    }
  } finally {
    value.close();
  }
});
