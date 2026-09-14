import assert from "node:assert/strict";
import test from "node:test";
import { toolFailure } from "../../src/tool-diagnostics.ts";
import { durationText } from "../../src/execution-duration.ts";

const command = { id: "command", type: "commandExecution", status: "failed", exitCode: 2 };

test("combined inspection reports the missing final script without hiding earlier output", () => {
  const output = "candidate snapshot\nselected 7 topics\n" + "print('source code')\n".repeat(1000)
    + "--- render driver ---\nsed: can't read scripts/render-html-video.mjs: No such file or directory\n";
  const item = { ...command, aggregatedOutput: output };
  assert.deepEqual(toolFailure(item), {
    message: "sed: can't read scripts/render-html-video.mjs: No such file or directory",
    hint: "命令引用的文件或目录不存在。先确认工作目录，再列出实际脚本路径；查看脚本失败不等于渲染失败。",
  });
  assert.equal(item.aggregatedOutput, output);
});

test("nonzero command exit remains a failure even when its item status says completed", () => {
  assert.deepEqual(toolFailure({ ...command, status: "completed", exitCode: 127, aggregatedOutput: "bash: missing-tool: command not found" }), {
    message: "bash: missing-tool: command not found",
    hint: "命令或解释器不存在，或不在 PATH 中。请先检查当前环境可用的工具。",
  });
});

test("successful, running and declined commands are not classified by error-like output", () => {
  const output = "example: No such file or directory\nERROR is documented here";
  assert.deepEqual([
    toolFailure({ ...command, status: "completed", exitCode: 0, aggregatedOutput: output }),
    toolFailure({ ...command, status: "completed", exitCode: null, aggregatedOutput: output }),
    toolFailure({ ...command, status: "inProgress", exitCode: null, aggregatedOutput: output }),
    toolFailure({ ...command, status: "declined", exitCode: null, aggregatedOutput: output }),
  ], [null, null, null, null]);
});

test("command permission and syntax failures never receive MCP advice", () => {
  for (const [output, expected] of [
    ["bash: ./render.sh: Permission denied", "权限"],
    ["bash: syntax error near unexpected token", "Shell 语法错误"],
    ["Terminated", "不能仅凭此判断内存不足"],
  ]) {
    const failure = toolFailure({ ...command, aggregatedOutput: output });
    assert.equal(failure.message, output);
    assert.ok(failure.hint.includes(expected));
    assert.ok(!failure.hint.includes("MCP"));
  }
});

test("command summaries prefer structured errors and fall back on real output for empty errors", () => {
  const output = "sed: can't read scripts/render.mjs: No such file or directory";
  assert.equal(toolFailure({ ...command, error: { message: "exec transport closed" }, aggregatedOutput: output }).message, "exec transport closed");
  assert.equal(toolFailure({ ...command, error: { message: " " }, aggregatedOutput: output }).message, output);
  assert.equal(toolFailure({ ...command, error: "EACCES: failed to spawn" }).message, "EACCES: failed to spawn");
});

test("silent failures and generic output are reported without inventing a cause or exit code", () => {
  assert.deepEqual(toolFailure({ ...command, exitCode: null }), {
    message: "命令未返回输出，请检查工作目录、退出码和运行环境。", hint: "",
  });
  assert.deepEqual(toolFailure({ ...command, aggregatedOutput: "phase 1\nphase 2" }), {
    message: "phase 1\nphase 2", hint: "这里显示的是命令末尾输出，不一定是根因；展开可查看完整输出和工作目录。",
  });
});

test("command error summaries strip terminal colors and remain bounded", () => {
  assert.equal(toolFailure({ ...command, aggregatedOutput: "\u001b[31mFileNotFoundError: missing input\u001b[0m\ncleanup finished\n" }).message, "FileNotFoundError: missing input");
  const huge = "x".repeat(100_000);
  assert.equal(toolFailure({ ...command, aggregatedOutput: huge }).message.length, 2000);
});

test("execution durations distinguish subsecond commands without regressing longer turns", () => {
  assert.deepEqual([0, 1, 300, 999, 1000, 59000, 60000, 61000, 3600000, 3660000, NaN].map(durationText), [
    "不足 1 秒", "不足 1 秒", "不足 1 秒", "不足 1 秒", "1 秒", "59 秒", "1 分钟", "1 分 1 秒", "1 小时", "1 小时 1 分", "耗时未知",
  ]);
});
