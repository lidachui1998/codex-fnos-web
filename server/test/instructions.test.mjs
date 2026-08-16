import assert from "node:assert/strict";
import test from "node:test";
import { composeDeveloperInstructions, defaultFnosInstructions } from "../instructions.mjs";

test("composes fnOS, personal, and project instructions in stable order", () => {
  assert.equal(composeDeveloperInstructions({
    fnosInstructionsEnabled: true,
    fnosInstructions: "NAS rules",
    personalInstructions: "Personal rules",
  }, "Project rules"), `## 飞牛 NAS 环境

NAS rules

## 个人指令

Personal rules

## 当前项目指令

Project rules`);
});

test("the default environment prompt identifies fnOS and destructive-operation safeguards", () => {
  assert.match(defaultFnosInstructions, /飞牛 fnOS NAS/);
  assert.match(defaultFnosInstructions, /先审计目标与影响/);
  assert.match(defaultFnosInstructions, /只操作当前项目/);
  assert.match(defaultFnosInstructions, /fnos_schedule/);
  assert.match(defaultFnosInstructions, /等待它们进入 completed、shutdown、failed 或 interrupted 等终态/);
  assert.match(defaultFnosInstructions, /不得在仍有子代理运行、等待批准或等待输入时提前结束主任务/);
});

test("disabled fnOS instructions are omitted", () => {
  assert.equal(composeDeveloperInstructions({
    fnosInstructionsEnabled: false,
    fnosInstructions: "NAS rules",
    personalInstructions: "Personal rules",
  }), "## 个人指令\n\nPersonal rules");
});
