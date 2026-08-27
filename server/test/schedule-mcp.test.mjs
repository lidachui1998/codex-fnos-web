import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../database.mjs";
import { ScheduleToolStore, handleScheduleMcpRequest } from "../schedule-mcp.mjs";
import { Stores } from "../stores.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-schedule-mcp-"));
  const workspace = join(root, "workspace");
  const databasePath = join(root, "store.sqlite");
  mkdirSync(workspace);
  const db = openDatabase(databasePath);
  const stores = new Stores(db, Buffer.alloc(32, 7), [root]);
  const project = stores.saveProject({ name: "NAS project", path: workspace, create: false });
  const provider = stores.saveProvider({ name: "Private AI", baseUrl: "https://ai.example/v1", model: "provider-default", apiKey: "secret", enabled: true });
  db.close();
  return { root, workspace, databasePath, project, provider };
}

test("creates and lists a scheduled task through the local MCP store", () => {
  const { root, workspace, databasePath, project } = fixture();
  const store = new ScheduleToolStore(databasePath);
  try {
    const created = store.create({
      name: "Morning report",
      prompt: "Check the project and write a report",
      projectPath: workspace,
      schedule: { type: "daily", time: "09:00" },
    });
    assert.equal(created.name, "Morning report");
    assert.equal(created.projectId, project.id);
    assert.equal(created.projectPath, workspace);
    assert.deepEqual(created.schedule, { type: "daily", time: "09:00" });
    assert.equal(created.enabled, true);
    assert.equal(created.networkAccess, true);
    assert.equal(created.providerMode, "follow");
    assert.equal(created.model, null);
    assert.ok(created.nextRunAt > Math.floor(Date.now() / 1000));
    assert.deepEqual(store.list(workspace), [created]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("edits model settings, pauses, and deletes a scheduled task through MCP", () => {
  const { root, workspace, databasePath, provider } = fixture();
  const store = new ScheduleToolStore(databasePath);
  try {
    const created = store.create({
      name: "Nightly build",
      prompt: "Build the package",
      projectPath: workspace,
      schedule: { type: "daily", time: "23:00" },
      providerId: provider.id,
      model: "provider-special",
      reasoningEffort: "high",
      sandboxMode: "unrestricted",
    });
    assert.equal(created.providerMode, "provider");
    assert.equal(created.providerId, provider.id);
    assert.equal(created.providerName, "Private AI");
    assert.equal(created.model, "provider-special");
    assert.equal(created.reasoningEffort, "high");
    assert.equal(created.sandboxMode, "unrestricted");

    const updated = store.update(created.id, {
      prompt: "Build and verify the package",
      schedule: { type: "weekly", time: "22:30", days: [1, 5] },
      providerId: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      enabled: false,
    });
    assert.equal(updated.prompt, "Build and verify the package");
    assert.deepEqual(updated.schedule, { type: "weekly", time: "22:30", days: [1, 5] });
    assert.equal(updated.providerMode, "openai");
    assert.equal(updated.providerName, "OpenAI / ChatGPT");
    assert.equal(updated.model, "gpt-5.6-sol");
    assert.equal(updated.reasoningEffort, "xhigh");
    assert.equal(updated.enabled, false);
    assert.equal(updated.nextRunAt, null);
    assert.deepEqual(store.delete(created.id), { deleted: true, id: created.id, name: "Nightly build" });
    assert.deepEqual(store.list(workspace), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exposes create and list tool definitions over MCP", () => {
  const { root, databasePath } = fixture();
  const store = new ScheduleToolStore(databasePath);
  try {
    const initialized = handleScheduleMcpRequest(store, {
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal(initialized.serverInfo.name, "fnos-workbench");
    const result = handleScheduleMcpRequest(store, { method: "tools/list" });
    assert.deepEqual(result.tools.map((tool) => tool.name), ["create_scheduled_task", "list_scheduled_tasks", "update_scheduled_task", "delete_scheduled_task", "create_new_conversation", "create_global_skill", "create_global_plugin"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("routes an explicit new conversation request through the workbench", async () => {
  const { root, databasePath, workspace } = fixture();
  const store = new ScheduleToolStore(databasePath);
  const calls = [];
  const conversations = {
    async create(input) {
      calls.push(input);
      return { status: "started", threadId: "thread-new", turnId: "turn-new", title: input.title };
    },
  };
  try {
    const result = await handleScheduleMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "create_new_conversation",
        arguments: { title: "检查渲染", prompt: "检查渲染进程", projectPath: workspace },
      },
    }, undefined, conversations);
    assert.deepEqual(result.structuredContent, {
      status: "started",
      threadId: "thread-new",
      turnId: "turn-new",
      title: "检查渲染",
    });
    assert.deepEqual(calls, [{ title: "检查渲染", prompt: "检查渲染进程", projectPath: workspace }]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("routes global extension creation through the approved MCP tools", () => {
  const { root, databasePath } = fixture();
  const store = new ScheduleToolStore(databasePath);
  const calls = [];
  const extensions = {
    createSkill(input) { calls.push({ kind: "skill", input }); return { kind: "skill", name: input.name, scope: "global" }; },
    createPlugin(input) { calls.push({ kind: "plugin", input }); return { kind: "plugin", name: input.name, scope: "global" }; },
  };
  try {
    const skill = handleScheduleMcpRequest(store, {
      method: "tools/call",
      params: { name: "create_global_skill", arguments: { name: "review", description: "Review", instructions: "Inspect." } },
    }, extensions);
    const plugin = handleScheduleMcpRequest(store, {
      method: "tools/call",
      params: { name: "create_global_plugin", arguments: { name: "release", description: "Release", instructions: "Summarize." } },
    }, extensions);
    assert.deepEqual(skill.structuredContent, { kind: "skill", name: "review", scope: "global" });
    assert.deepEqual(plugin.structuredContent, { kind: "plugin", name: "release", scope: "global" });
    assert.deepEqual(calls, [
      { kind: "skill", input: { name: "review", description: "Review", instructions: "Inspect." } },
      { kind: "plugin", input: { name: "release", description: "Release", instructions: "Summarize." } },
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
