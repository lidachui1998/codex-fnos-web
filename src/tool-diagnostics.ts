import type { ThreadItem } from "./types";

function errorMessage(error: unknown) {
  if (typeof error === "string") return error.trim();
  if (error && typeof error === "object" && "message" in error) return String(error.message ?? "").trim();
  return "";
}

function commandFailure(item: ThreadItem) {
  if (item.status === "declined" || (item.status === "inProgress" && !item.error)) return null;
  const hasExitCode = typeof item.exitCode === "number" && Number.isFinite(item.exitCode);
  if (!item.error && item.status !== "failed" && !(hasExitCode && item.exitCode !== 0)) return null;
  // Inspect only a bounded tail. The expanded view keeps the original output intact.
  const lines = (item.aggregatedOutput ?? "").slice(-16384)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r\n?|\n/).map((line) => line.trim()).filter(Boolean).slice(-24);
  const diagnostic = [...lines].reverse().find((line) => /no such file or directory|command not found|permission denied|\b(?:ENOENT|EACCES|EPERM)\b|\b[\w.]*Error:|\berror[: ]|syntax error|terminated|killed/i.test(line));
  const output = diagnostic || lines.slice(-4).join("\n");
  const message = (errorMessage(item.error) || output || "命令未返回输出，请检查工作目录、退出码和运行环境。").slice(-2000);
  let hint = "";
  if (/no such file or directory|\bENOENT\b/i.test(message)) hint = "命令引用的文件或目录不存在。先确认工作目录，再列出实际脚本路径；查看脚本失败不等于渲染失败。";
  else if (/command not found/i.test(message)) hint = "命令或解释器不存在，或不在 PATH 中。请先检查当前环境可用的工具。";
  else if (/permission denied|\b(?:EACCES|EPERM)\b/i.test(message)) hint = "当前进程没有所需访问或执行权限，请核对目标路径和权限。";
  else if (/syntax error/i.test(message)) hint = "Shell 语法错误。请检查原始命令的引号、换行和 heredoc 结束标记。";
  else if (/terminated|killed/i.test(message)) hint = "输出提示进程被终止；需要结合进程日志确认原因，不能仅凭此判断内存不足。";
  else if (output && !diagnostic && !errorMessage(item.error)) hint = "这里显示的是命令末尾输出，不一定是根因；展开可查看完整输出和工作目录。";
  return { message, hint };
}

export function toolFailure(item: ThreadItem) {
  if (item.type === "commandExecution") return commandFailure(item);
  const result = item.result as { isError?: boolean; is_error?: boolean; content?: Array<{ text?: string }> } | null;
  const failure = item.error;
  if (!failure && !result?.isError && !result?.is_error && item.status !== "failed") return null;
  const message = errorMessage(failure) || result?.content?.map((entry) => entry.text || "").filter(Boolean).join("\n") || "工具未返回具体错误。";
  const resourceCall = /(?:read|list)_mcp_resource/.test(item.tool || "");
  let hint = "";
  if (/unknown.*server|server.*not found|未找到.*服务/i.test(message)) hint = "当前会话没有加载这个 MCP 服务。请在设置 → 服务与 MCP 检查并重载。";
  else if (resourceCall && /method not found|not supported|unsupported|-32601/i.test(message)) hint = "该服务不支持此资源操作；请使用它实际提供的搜索等工具。";
  else if (/401|403|unauthorized|unauthenticated|not logged in/i.test(message)) hint = "MCP 服务认证或权限失败，请检查该服务的登录和令牌配置。";
  else if (/timeout|timed out|connection|transport.*closed|ECONN|ENOTFOUND|handshak/i.test(message)) hint = "MCP 连接中断或超时。请检查服务和网络，然后在设置 → 服务与 MCP 重载。";
  return { message, hint };
}

export function toolDetail(item: ThreadItem) {
  return JSON.stringify({ ...(item.error ? { error: item.error } : {}),
    ...(item.result != null ? { result: item.result } : {}),
    ...(item.arguments != null ? { arguments: item.arguments } : {}),
    ...(item.progress ? { progress: item.progress } : {}) }, null, 2);
}
