const maxAutomationBytes = 256 * 1024;
const maxMemoryBytes = 512 * 1024;
const reasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const dayNumbers = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function inputError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      throw inputError("automation.toml 包含当前导入器无法解析的字符串或数组");
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export function parseDesktopAutomationToml(source) {
  const text = String(source || "");
  if (!text.trim()) throw inputError("请选择电脑 Codex 的 automation.toml");
  if (Buffer.byteLength(text, "utf8") > maxAutomationBytes) throw inputError("automation.toml 不能超过 256KB");
  const result = {};
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let raw = match[2];
    if (raw.startsWith('"""')) {
      const chunks = [raw.slice(3)];
      while (!chunks[chunks.length - 1].endsWith('"""') && index + 1 < lines.length) chunks.push(lines[++index]);
      if (!chunks[chunks.length - 1].endsWith('"""')) throw inputError(`automation.toml 的 ${match[1]} 多行字符串没有结束`);
      chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(0, -3);
      result[match[1]] = chunks.join("\n");
      continue;
    }
    result[match[1]] = parseTomlValue(raw);
  }
  return result;
}

export function scheduleFromRRule(value) {
  const raw = String(value || "").trim().replace(/^RRULE:/i, "");
  if (!raw) throw inputError("automation.toml 缺少 rrule");
  const parts = Object.fromEntries(raw.split(";").map((part) => part.split("=", 2)).filter((part) => part.length === 2).map(([key, entry]) => [key.toUpperCase(), entry]));
  const hour = Number(parts.BYHOUR);
  const minute = Number(parts.BYMINUTE || 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw inputError("当前仅支持带 BYHOUR/BYMINUTE 的桌面日程");
  }
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (parts.FREQ === "DAILY") return { type: "daily", time };
  if (parts.FREQ === "WEEKLY") {
    const days = String(parts.BYDAY || "").split(",").map((day) => dayNumbers[day]).filter((day) => Number.isInteger(day)).sort();
    if (days.length === 7) return { type: "daily", time };
    if (days.length > 0) return { type: "weekly", time, days: [...new Set(days)] };
  }
  if (parts.FREQ === "MINUTELY") {
    const minutes = Number(parts.INTERVAL || 1);
    if (Number.isInteger(minutes) && minutes >= 5 && minutes <= 10_080) return { type: "interval", minutes };
  }
  throw inputError(`暂不支持这个 RRULE：${value}`);
}

function compatibilityIssues(automation, sourceCwd) {
  const prompt = String(automation.prompt || "");
  const issues = [];
  if (sourceCwd && /^[A-Za-z]:[\\/]/.test(sourceCwd)) issues.push({ severity: "warning", code: "windows-cwd", message: `Windows 工作目录 ${sourceCwd} 将映射到所选 fnOS 项目目录` });
  if (/\bpowershell\b|\.ps1\b/i.test(prompt)) issues.push({ severity: "blocker", code: "powershell", message: "原任务调用 PowerShell/.ps1；fnOS 是 Linux，导入后会暂停，需提供 .sh 或 Node.js 等价脚本" });
  if (/chrome|创作者中心|浏览器登录|existing signed-in/i.test(prompt)) issues.push({ severity: "blocker", code: "desktop-browser", message: "原任务依赖电脑浏览器登录态；NAS 无法继承该登录态，需改成 NAS 可用的 API 或人工发布交接" });
  if (/[A-Za-z]:\\/.test(prompt)) issues.push({ severity: "warning", code: "windows-path", message: "任务提示词中仍有 Windows 盘符路径，运行前必须改成 fnOS 路径" });
  if (/ffmpeg|ffprobe/i.test(prompt)) issues.push({ severity: "warning", code: "native-tools", message: "任务需要 FFmpeg/ffprobe；请确认它们已安装并加入 fnOS 应用运行 PATH" });
  return issues;
}

function buildFnosPrompt(originalPrompt, sourceCwd, projectPath) {
  const mappedPrompt = sourceCwd ? originalPrompt.split(sourceCwd).join(projectPath) : originalPrompt;
  return `## 从电脑 Codex 迁移到 fnOS 的执行约束

- 当前运行环境是 fnOS NAS（Linux），当前项目目录是 ${projectPath}。
- 电脑上的原工作目录 ${sourceCwd || "未记录"} 已映射到当前项目目录；不得访问 Windows 盘符。
- 不要调用 PowerShell、.ps1、Windows Chrome 或电脑本地登录态。先在项目中寻找 Linux/Node.js 等价脚本；不存在时明确报告兼容阻塞，不得伪造完成。
- 使用 NAS 中实际存在的 node、npm、ffmpeg、浏览器或网络工具；执行后检查退出码和产物。

## 原桌面任务

${mappedPrompt}`;
}

export function prepareDesktopAutomationImport(input, project) {
  if (!project?.id || !project?.path) throw inputError("请选择接收任务的 fnOS 项目");
  const automation = parseDesktopAutomationToml(input.automationToml);
  const originalPrompt = String(automation.prompt || "").trim();
  if (!originalPrompt) throw inputError("automation.toml 缺少 prompt");
  const sourceCwd = Array.isArray(automation.cwds) ? String(automation.cwds[0] || "") : "";
  const issues = compatibilityIssues(automation, sourceCwd);
  const prompt = buildFnosPrompt(originalPrompt, sourceCwd, project.path);
  if (prompt.length > 20_000) throw inputError("迁移后的任务提示词超过 20000 字符，请先精简桌面任务");
  const memory = String(input.memory || "");
  if (Buffer.byteLength(memory, "utf8") > maxMemoryBytes) throw inputError("memory.md 不能超过 512KB");
  const effort = reasoningEfforts.has(String(automation.reasoning_effort || "")) ? String(automation.reasoning_effort) : null;
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  const desktopEnabled = String(automation.status || "active").toLowerCase() === "active";
  const task = {
    name: String(automation.name || automation.id || "从电脑导入的定时任务").trim().slice(0, 120),
    projectId: project.id,
    prompt,
    sourcePrompt: originalPrompt,
    schedule: scheduleFromRRule(automation.rrule),
    enabled: desktopEnabled && blockers.length === 0,
    model: String(automation.model || "").trim().slice(0, 120) || null,
    reasoningEffort: effort,
    sourceAutomationId: String(automation.id || "").trim().slice(0, 160) || null,
    sourceCwd: sourceCwd.slice(0, 1_000) || null,
    memory,
    compatibility: issues,
  };
  return {
    task,
    preview: {
      sourceAutomationId: task.sourceAutomationId,
      name: task.name,
      schedule: task.schedule,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
      sourceCwd: task.sourceCwd,
      targetCwd: project.path,
      memoryBytes: Buffer.byteLength(memory, "utf8"),
      enabledAfterImport: task.enabled,
      issues,
    },
  };
}
