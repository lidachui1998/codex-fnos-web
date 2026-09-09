import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerBridge } from "../app-server-bridge.mjs";

function setup(t, modes) {
  const root = mkdtempSync(join(tmpdir(), "bridge-lifecycle-"));
  const children = [];
  const bridge = new AppServerBridge({ codexBin: "mock-codex", codexHome: join(root, "home"), databasePath: join(root, "db"), gatewayBaseUrl: "http://127.0.0.1", gatewayToken: "test",
    stores: { getSettings: () => ({}), listProviders: () => [] },
    spawnProcess: () => {
      const mode = modes[children.length] || "ready";
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.pid = mode === "spawn-error" ? undefined : 100 + children.length;
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal);
        if (mode === "ignore-term" && signal === "SIGTERM") return;
        queueMicrotask(() => child.emit("exit", null, signal));
      };
      child.stdin.on("data", (buffer) => {
        const message = JSON.parse(buffer.toString());
        if (message.method !== "initialize") return;
        queueMicrotask(() => {
          if (mode === "early-exit") child.emit("exit", 1, null);
          else child.stdout.write(JSON.stringify(mode === "initialize-error"
            ? { id: message.id, error: { message: "initialization rejected" } }
            : { id: message.id, result: {} }) + "\n");
        });
      });
      children.push(child);
      queueMicrotask(() => mode === "spawn-error" ? child.emit("error", new Error("ENOENT")) : child.emit("spawn"));
      return child;
    },
  });
  t.after(async () => { await bridge.stop(); rmSync(root, { recursive: true, force: true }); });
  return { bridge, children };
}

test("early initialization exit rejects promptly and can be restarted", { timeout: 2000 }, async (t) => {
  const { bridge } = setup(t, ["early-exit", "ready"]);
  await assert.rejects(bridge.start(), /已退出|初始化完成前退出/);
  assert.equal(bridge.child, null);
  assert.equal(bridge.pending.size, 0);
  await bridge.restart();
  assert.equal(bridge.snapshot().status, "ready");
});

test("failed spawn does not leave a phantom child that makes stop hang", { timeout: 2000 }, async (t) => {
  const { bridge } = setup(t, ["spawn-error", "ready"]);
  await assert.rejects(bridge.start(), /ENOENT/);
  assert.equal(bridge.child, null);
  await bridge.restart();
  assert.equal(bridge.snapshot().status, "ready");
});

test("concurrent restart requests create one replacement process", async (t) => {
  const { bridge, children } = setup(t, ["ready", "ready"]);
  await bridge.start();
  await Promise.all([bridge.restart(), bridge.restart(), bridge.restart()]);
  assert.equal(children.length, 2);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  assert.equal(bridge.snapshot().status, "ready");
});

test("failed initialization terminates the unusable process and permits recovery", { timeout: 2000 }, async (t) => {
  const { bridge, children } = setup(t, ["initialize-error", "ready"]);
  await assert.rejects(bridge.start(), /initialization rejected/);
  assert.equal(children[0].signals.length, 1);
  await bridge.restart();
  assert.equal(bridge.snapshot().status, "ready");
});

test("stop escalates a nonresponsive SIGTERM to SIGKILL", async (t) => {
  const { bridge, children } = setup(t, ["ignore-term"]);
  await bridge.start();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopped = bridge.stop();
  t.mock.timers.tick(3000);
  await stopped;
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(bridge.snapshot().status, "stopped");
});
