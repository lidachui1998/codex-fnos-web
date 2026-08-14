import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../database.mjs";
import { defaultFnosInstructions } from "../instructions.mjs";
import { computeNextRun, normalizeSchedule, ScheduleService } from "../schedule-service.mjs";
import { Stores } from "../stores.mjs";

test("normalizes supported schedule shapes", () => {
  assert.deepEqual(normalizeSchedule({ type: "interval", minutes: 30 }), { type: "interval", minutes: 30 });
  assert.deepEqual(normalizeSchedule({ type: "daily", time: "09:15" }), { type: "daily", time: "09:15" });
  assert.deepEqual(normalizeSchedule({ type: "weekly", time: "08:00", days: [5, 1, 5] }), { type: "weekly", time: "08:00", days: [1, 5] });
});

test("rejects unsafe or ambiguous schedule values", () => {
  assert.throws(() => normalizeSchedule({ type: "interval", minutes: 1 }), /5 到 10080/);
  assert.throws(() => normalizeSchedule({ type: "daily", time: "24:00" }), /HH:mm/);
  assert.throws(() => normalizeSchedule({ type: "weekly", time: "09:00", days: [] }), /至少选择一天/);
});

test("computes interval and daily next runs", () => {
  const from = new Date(2026, 7, 10, 9, 30, 0, 0);
  assert.equal(computeNextRun({ type: "interval", minutes: 30 }, from), Math.floor(new Date(2026, 7, 10, 10, 0, 0, 0).getTime() / 1000));
  assert.equal(computeNextRun({ type: "daily", time: "09:00" }, from), Math.floor(new Date(2026, 7, 11, 9, 0, 0, 0).getTime() / 1000));
});

test("computes the next selected weekday", () => {
  const monday = new Date(2026, 7, 10, 9, 30, 0, 0);
  assert.equal(computeNextRun({ type: "weekly", time: "08:00", days: [1, 3] }, monday), Math.floor(new Date(2026, 7, 12, 8, 0, 0, 0).getTime() / 1000));
});

test("supports explicit unrestricted tasks while preserving default and legacy isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-schedule-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(join(root, "store.sqlite"));
  const stores = new Stores(db, Buffer.alloc(32, 9), [root]);
  const project = stores.saveProject({ name: "NAS project", path: workspace, create: false });
  class FakeBridge extends EventEmitter {
    calls = [];
    snapshot() { return { status: "ready" }; }
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-scheduled" } };
      if (method === "turn/start") return { turn: { id: "turn-scheduled" } };
      throw new Error(`unexpected method: ${method}`);
    }
  }
  const bridge = new FakeBridge();
  const service = new ScheduleService({ stores, bridge });
  try {
    const blocker = { severity: "blocker", code: "powershell", message: "需要 PowerShell" };
    assert.throws(() => service.save({
      name: "Imported Windows task",
      projectId: project.id,
      prompt: "Run the migrated workflow",
      schedule: { type: "daily", time: "08:00" },
      enabled: true,
      compatibility: [blocker],
    }), /兼容阻塞/);
    const blockedTask = service.save({
      name: "Imported Windows task",
      projectId: project.id,
      prompt: "Run the migrated workflow",
      schedule: { type: "daily", time: "08:00" },
      enabled: false,
      compatibility: [blocker],
    });
    const adaptedTask = service.save({ enabled: true, resolveCompatibility: true }, blockedTask.id);
    assert.equal(adaptedTask.enabled, true);
    assert.deepEqual(adaptedTask.compatibility, [{
      severity: "warning",
      code: "powershell",
      message: "已确认完成 fnOS 适配：需要 PowerShell",
      resolved: true,
    }]);

    const task = service.save({
      name: "Daily check",
      projectId: project.id,
      prompt: "Inspect the project",
      schedule: { type: "daily", time: "09:00" },
      enabled: true,
      sandboxMode: "unrestricted",
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh",
      sourceAutomationId: "desktop-daily-check",
      memory: "# imported memory",
      compatibility: [],
    });
    const readTask = () => service.list().find((item) => item.id === task.id);
    assert.deepEqual(await service.runNow(task.id), {
      runId: readTask().runs[0].id,
      threadId: "thread-scheduled",
      turnId: "turn-scheduled",
    });
    assert.deepEqual(bridge.calls.map(({ method, params }) => ({
      method,
      approvalPolicy: params.approvalPolicy,
      sandbox: params.sandbox,
      sandboxPolicy: params.sandboxPolicy,
      threadSource: params.threadSource,
      model: params.model,
      effort: params.effort,
      config: params.config,
    })), [
      { method: "thread/start", approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: undefined, threadSource: "automation", model: "gpt-5.6-terra", effort: undefined, config: { "agents.enabled": true, "agents.max_concurrent_threads_per_session": 4, experimental_use_unified_exec_tool: true, background_terminal_max_timeout: 3_600_000, model_reasoning_effort: "xhigh" } },
      { method: "turn/start", approvalPolicy: "never", sandbox: undefined, sandboxPolicy: { type: "dangerFullAccess" }, threadSource: undefined, model: "gpt-5.6-terra", effort: "xhigh", config: undefined },
    ]);
    assert.match(bridge.calls[0].params.developerInstructions, new RegExp(defaultFnosInstructions.slice(0, 30)));
    assert.match(bridge.calls[0].params.developerInstructions, /可以访问任意互联网地址/);
    assert.match(bridge.calls[0].params.developerInstructions, /# imported memory/);
    assert.match(bridge.calls[0].params.developerInstructions, /持续轮询同一个进程或会话/);
    assert.equal(bridge.calls[1].params.input[0].text, "Inspect the project");
    assert.equal(stores.getThreadPreferences("thread-scheduled").name, "定时：Daily check");
    assert.equal(stores.getThreadPreferences("thread-scheduled").approvalPolicy, "never");
    assert.equal(stores.getThreadPreferences("thread-scheduled").networkAccess, true);
    assert.equal(readTask().networkAccess, true);
    assert.equal(readTask().sandboxMode, "unrestricted");
    assert.equal(readTask().memoryBytes, Buffer.byteLength("# imported memory"));

    bridge.emit("event", {
      kind: "notification",
      method: "turn/completed",
      params: {
        threadId: "thread-scheduled",
        turn: { status: "completed", items: [{ type: "agentMessage", text: "All good" }] },
      },
    });
    assert.deepEqual(readTask().runs[0], {
      id: readTask().runs[0].id,
      threadId: "thread-scheduled",
      turnId: "turn-scheduled",
      status: "succeeded",
      output: "All good",
      error: null,
      startedAt: readTask().runs[0].startedAt,
      completedAt: readTask().runs[0].completedAt,
    });

    const workspaceTask = service.save({
      name: "Workspace check",
      projectId: project.id,
      prompt: "Inspect inside the project sandbox",
      schedule: { type: "daily", time: "09:30" },
      enabled: true,
    });
    assert.equal(workspaceTask.sandboxMode, "workspace");
    await service.runNow(workspaceTask.id);
    assert.deepEqual(bridge.calls.slice(2, 4).map(({ method, params }) => ({
      method,
      sandbox: params.sandbox,
      sandboxPolicy: params.sandboxPolicy,
    })), [
      { method: "thread/start", sandbox: "workspace-write", sandboxPolicy: undefined },
      { method: "turn/start", sandbox: undefined, sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: true } },
    ]);

    const legacy = service.save({
      name: "Legacy check",
      projectId: project.id,
      prompt: "Inspect without changes",
      schedule: { type: "daily", time: "10:00" },
      enabled: true,
    });
    assert.equal(legacy.sandboxMode, "workspace");
    stores.db.prepare("UPDATE scheduled_tasks SET network_access = 0 WHERE id = ?").run(legacy.id);
    await service.runNow(legacy.id);
    assert.deepEqual(bridge.calls.slice(4).map(({ method, params }) => ({
      method,
      sandbox: params.sandbox,
      sandboxPolicy: params.sandboxPolicy,
    })), [
      { method: "thread/start", sandbox: "read-only", sandboxPolicy: undefined },
      { method: "turn/start", sandbox: undefined, sandboxPolicy: { type: "readOnly" } },
    ]);
    assert.equal(stores.getThreadPreferences("thread-scheduled").networkAccess, false);
  } finally {
    service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
