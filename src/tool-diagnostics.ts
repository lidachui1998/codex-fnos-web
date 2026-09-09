import type { ThreadItem } from "./types";

export function toolFailure(item: ThreadItem) {
  const result = item.result as { isError?: boolean; is_error?: boolean; content?: Array<{ text?: string }> } | null;
  const failure = item.error;
  if (!failure && !result?.isError && !result?.is_error && item.status !== "failed") return null;
  const message = typeof failure === "string" ? failure
    : failure && typeof failure === "object" && "message" in failure ? String(failure.message)
    : result?.content?.map((entry) => entry.text || "").filter(Boolean).join("\n") || "工具未返回具体错误。";
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
