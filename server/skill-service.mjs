import { readFileSync, statSync } from "node:fs";

const maxSkillBytes = 512 * 1024;

function skillPath(value) {
  return String(value || "");
}

export class SkillService {
  constructor(bridge, { installer } = {}) {
    this.bridge = bridge;
    this.installer = installer;
  }

  async install(project, input) {
    if (!this.installer) throw Object.assign(new Error("当前环境未启用 GitHub Skill 安装"), { status: 501 });
    const installed = await this.installer.install(input);
    return { installed, ...(await this.list(project, true)) };
  }

  async list(project, forceReload = false) {
    const result = await this.bridge.request("skills/list", {
      cwds: [project.path],
      forceReload: Boolean(forceReload),
    });
    const entry = result?.data?.find((item) => String(item.cwd) === String(project.path)) ?? result?.data?.[0];
    return {
      cwd: entry?.cwd ?? project.path,
      skills: Array.isArray(entry?.skills) ? entry.skills : [],
      errors: Array.isArray(entry?.errors) ? entry.errors : [],
    };
  }

  async setEnabled(project, input) {
    const current = await this.list(project, false);
    const path = skillPath(input.path);
    const skill = current.skills.find((item) => skillPath(item.path) === path);
    if (!skill) throw Object.assign(new Error("Skill 不存在或不属于当前项目"), { status: 404 });
    await this.bridge.request("skills/config/write", {
      path: skill.path,
      name: null,
      enabled: Boolean(input.enabled),
    });
    return this.list(project, true);
  }

  async read(project, value) {
    const current = await this.list(project, false);
    const path = skillPath(value);
    const skill = current.skills.find((item) => skillPath(item.path) === path);
    if (!skill) throw Object.assign(new Error("Skill 不存在或不属于当前项目"), { status: 404 });
    const stats = statSync(path);
    if (!stats.isFile()) throw Object.assign(new Error("Skill 主文件不存在"), { status: 404 });
    if (stats.size > maxSkillBytes) throw Object.assign(new Error("Skill 文件超过 512 KB，无法预览"), { status: 413 });
    const content = readFileSync(path);
    if (content.includes(0)) throw Object.assign(new Error("Skill 文件不是文本内容"), { status: 415 });
    return { skill, content: content.toString("utf8") };
  }
}
