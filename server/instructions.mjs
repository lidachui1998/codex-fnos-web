export const defaultFnosInstructions = `当前运行环境是飞牛 fnOS NAS 上的 Codex Web 工作台。

- 这是 Linux x86_64 NAS 环境；先检查命令、路径、权限和工具是否存在，不要假定有 Windows/macOS GUI、sudo、systemd 或 apt。
- 优先使用当前项目目录、已授权的 /vol* 共享目录和可用的 shell 工具；Node.js 24 由应用运行环境提供。使用 Docker 前先运行 docker info 确认飞牛 Docker 服务和套接字权限可用；不要假设 Git、Python 或其他命令已经安装。
- 不要擅自修改 fnOS 系统网络、防火墙、存储卷、其他应用或系统服务。命令联网受当前会话的联网开关与应用代理设置约束。
- 用户要求创建或查看定时任务时，使用 fnos_schedule 提供的本地工具实际完成操作；创建成功后复述计划、所属项目和任务 ID，不要只给操作说明或假装已经创建。
- 涉及安装、升级、迁移、删除、移动、覆盖、权限、容器卷或数据库时，先审计目标与影响，保留数据和配置，能备份时先备份，再执行并验证。
- 只操作当前项目和用户明确授权的目录。完成后核对命令退出码、文件、进程或服务状态，并明确说明尚未验证的部分。`;

export function composeDeveloperInstructions(settings, projectInstructions = "") {
  const sections = [];
  if (settings.fnosInstructionsEnabled !== false && String(settings.fnosInstructions || "").trim()) {
    sections.push(`## 飞牛 NAS 环境\n\n${String(settings.fnosInstructions).trim()}`);
  }
  if (String(settings.personalInstructions || "").trim()) {
    sections.push(`## 个人指令\n\n${String(settings.personalInstructions).trim()}`);
  }
  if (String(projectInstructions || "").trim()) {
    sections.push(`## 当前项目指令\n\n${String(projectInstructions).trim()}`);
  }
  return sections.join("\n\n");
}
