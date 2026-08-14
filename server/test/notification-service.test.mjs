import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../database.mjs";
import { NotificationService } from "../notification-service.mjs";
import { Stores } from "../stores.mjs";

function fixture(fetchImpl = async () => ({ ok: true, status: 200, text: async () => "{}" })) {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-notifications-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(join(root, "store.sqlite"));
  const stores = new Stores(db, Buffer.alloc(32, 4), [workspace]);
  const bridge = new EventEmitter();
  const service = new NotificationService({ stores, bridge, fetchImpl });
  return {
    bridge,
    service,
    stores,
    close() {
      service.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("tracks running, waiting and completed task activity with unread filters", () => {
  const value = fixture();
  try {
    const project = value.stores.saveProject({ name: "NAS project", path: value.stores.workspaceRoots[0], create: false });
    value.stores.saveThreadApprovalPolicy("thread-1", "on-request");
    value.stores.saveThreadProjectId("thread-1", project.id);
    value.stores.saveThreadDisplayName("thread-1", "Long analysis");

    value.bridge.emit("event", { kind: "notification", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    assert.deepEqual(value.service.summary(), { unread: 0, running: 1, failed: 0, scheduled: 0 });
    assert.equal(value.service.list({ filter: "running" }).data[0].title, "Long analysis");

    value.bridge.emit("event", { kind: "server_request", request: { id: 8, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" } } });
    assert.equal(value.service.list({ filter: "unread" }).data[0].status, "waiting");

    value.bridge.emit("event", { kind: "notification", method: "serverRequest/resolved", params: { requestId: 8 } });
    assert.equal(value.service.list({ filter: "running" }).data[0].status, "running");

    value.bridge.emit("event", { kind: "notification", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "Finished" }] } } });
    const completed = value.service.list({ filter: "unread" }).data[0];
    assert.deepEqual({ status: completed.status, source: completed.source, message: completed.message, projectId: completed.projectId }, {
      status: "completed",
      source: "chat",
      message: "Finished",
      projectId: project.id,
    });
    assert.equal(value.service.markRead(completed.id), true);
    assert.equal(value.service.summary().unread, 0);
  } finally {
    value.close();
  }
});

test("backfills project links for notifications created by legacy threads", () => {
  const value = fixture();
  try {
    const project = value.stores.saveProject({ name: "Legacy project", path: value.stores.workspaceRoots[0], create: false });
    value.bridge.emit("event", { kind: "notification", method: "turn/started", params: { threadId: "legacy-thread", turn: { id: "legacy-turn" } } });
    value.bridge.emit("event", { kind: "notification", method: "turn/completed", params: { threadId: "legacy-thread", turn: { id: "legacy-turn", status: "completed", items: [] } } });
    assert.equal(value.service.list().data[0].projectId, null);

    value.stores.saveThreadProjectId("legacy-thread", project.id);

    assert.equal(value.service.list().data[0].projectId, project.id);
    assert.equal(value.stores.db.prepare("SELECT project_id FROM notifications WHERE thread_id = ?").get("legacy-thread").project_id, project.id);
  } finally {
    value.close();
  }
});

test("signs Hermes over the exact compact JSON body and keeps secrets private", async () => {
  const calls = [];
  const value = fixture(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "delivered" }) };
  });
  try {
    value.service.saveChannel("hermes", {
      enabled: true,
      webhookUrl: "http://192.168.5.4:8644/webhooks/notify",
      secret: "route-secret",
      events: ["completed"],
    });
    await value.service.testChannel("hermes");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://192.168.5.4:8644/webhooks/notify");
    assert.equal(calls[0].options.agent, undefined);
    assert.deepEqual(JSON.parse(calls[0].options.body), { message: JSON.parse(calls[0].options.body).message });
    assert.equal(
      calls[0].options.headers["X-Webhook-Signature"],
      createHmac("sha256", "route-secret").update(calls[0].options.body).digest("hex"),
    );
    const publicChannel = value.service.listChannels().find((item) => item.channel === "hermes");
    assert.equal(publicChannel.hasSecret, true);
    assert.equal(Object.hasOwn(publicChannel, "secret"), false);
    assert.equal(Object.hasOwn(publicChannel, "webhookUrl"), false);
  } finally {
    value.close();
  }
});

test("sends Feishu V2 text payloads and detects timeout failures", async () => {
  const calls = [];
  const value = fixture(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, msg: "success" }) };
  });
  try {
    value.service.saveChannel("feishu", {
      enabled: true,
      webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/example",
      secret: "feishu-secret",
      events: ["completed", "timeout"],
    });
    await value.service.testChannel("feishu");
    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.msg_type, "text");
    assert.equal(payload.sign, createHmac("sha256", `${payload.timestamp}\nfeishu-secret`).update("").digest("base64"));
    value.service.saveChannel("feishu", { enabled: false });

    value.bridge.emit("event", { kind: "notification", method: "turn/started", params: { threadId: "thread-timeout", turn: { id: "turn-timeout" } } });
    value.bridge.emit("event", { kind: "notification", method: "turn/completed", params: { threadId: "thread-timeout", turn: { id: "turn-timeout", status: "failed", error: { message: "provider request timed out" } } } });
    assert.equal(value.service.list({ filter: "failed" }).data[0].status, "timeout");
  } finally {
    value.close();
  }
});
