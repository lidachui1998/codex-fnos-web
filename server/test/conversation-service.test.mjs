import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationService } from "../conversation-service.mjs";
import { openDatabase } from "../database.mjs";
import { Stores } from "../stores.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-conversation-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(join(root, "store.sqlite"));
  const stores = new Stores(db, Buffer.alloc(32, 9), [root]);
  const project = stores.saveProject({ name: "NAS project", path: workspace, create: false });
  const calls = [];
  const bridge = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-new", cwd: workspace }, approvalPolicy: "on-request" };
      if (method === "turn/start") return { turn: { id: "turn-new" } };
      throw new Error(`unexpected method: ${method}`);
    },
  };
  return { root, workspace, db, stores, project, calls, bridge };
}

test("Codex can start a user-visible conversation and its first turn", async () => {
  const value = fixture();
  const created = [];
  const service = new ConversationService({
    stores: value.stores,
    bridge: value.bridge,
    onCreated: (event) => created.push(event),
  });
  try {
    const result = await service.create({
      title: "检查渲染",
      prompt: "检查新的 HyperFrames 渲染",
      projectPath: value.workspace,
    });
    assert.deepEqual(result, {
      status: "started",
      threadId: "thread-new",
      turnId: "turn-new",
      title: "检查渲染",
      projectId: value.project.id,
      projectPath: value.workspace,
    });
    assert.equal(value.calls[0].method, "thread/start");
    assert.equal(value.calls[0].params.cwd, value.workspace);
    assert.equal(value.calls[0].params.modelProvider, "openai");
    assert.equal(value.calls[0].params.serviceName, "codex_fnos_handoff");
    assert.deepEqual(value.calls[1], {
      method: "turn/start",
      params: {
        threadId: "thread-new",
        clientUserMessageId: value.calls[1].params.clientUserMessageId,
        input: [{ type: "text", text: "检查新的 HyperFrames 渲染" }],
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [value.workspace], networkAccess: true },
        model: undefined,
      },
    });
    assert.match(value.calls[1].params.clientUserMessageId, /^handoff-/);
    const preferences = value.stores.getThreadPreferences("thread-new");
    assert.deepEqual(preferences, {
      approvalPolicy: "on-request",
      name: "检查渲染",
      pinned: false,
      deleted: false,
      archivedLocal: false,
      networkAccess: true,
      projectId: value.project.id,
      updatedAt: preferences.updatedAt,
    });
    assert.ok(Number.isInteger(preferences.updatedAt));
    assert.deepEqual(created, [{
      projectId: value.project.id,
      thread: {
        id: "thread-new",
        cwd: value.workspace,
        name: "检查渲染",
        projectId: value.project.id,
        approvalPolicy: "on-request",
        networkAccess: true,
      },
    }]);
  } finally {
    value.db.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});
