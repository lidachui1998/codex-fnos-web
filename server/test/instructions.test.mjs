import assert from "node:assert/strict";
import test from "node:test";
import { composeDeveloperInstructions, defaultFnosInstructions } from "../instructions.mjs";

const mcpSection = "## MCP 调用\n\n只使用本轮实际提供的 MCP 服务名和工具名；不要根据历史记录猜测服务名或 URI。搜索应调用实际提供的搜索工具，资源只能读取已列出的 URI。遇到 unknown MCP server 或 method not found 时，停止重复调用该服务或接口，说明未加载或不支持的具体原因，并使用现有可用工具继续。";
const scriptSection = "## 项目脚本与诊断\n\n读取或执行项目脚本前，先确认当前工作目录，再通过 rg --files 或目录列表确认实际路径；不要猜测脚本文件名。遇到文件不存在时，先查找项目的真实入口，不要反复重试同一路径。区分查看脚本与执行脚本：读取渲染脚本失败不等于渲染器失败。组合命令失败时检查退出码和末尾错误，保留前面已成功步骤的结果；不要为消除红色状态而忽略退出码或隐藏错误。";

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

Project rules\n\n${mcpSection}\n\n${scriptSection}`);
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
  }), `## 个人指令\n\nPersonal rules\n\n${mcpSection}\n\n${scriptSection}`);
});
