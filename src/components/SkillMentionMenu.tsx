import { AtSign, Boxes, FileCode2, Folder, Sparkles } from "lucide-react";
import type { PluginSummary, Skill } from "../types";

export type SkillMention = {
  start: number;
  end: number;
  query: string;
};

export function findSkillMention(value: string, cursor: number): SkillMention | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|[\s([{，。！？；：])@([^\s@]*)$/u);
  if (!match || match.index === undefined) return null;
  const atOffset = match[0].lastIndexOf("@");
  return {
    start: match.index + atOffset,
    end: cursor,
    query: match[1],
  };
}

export function matchingSkills(skills: Skill[], query: string, selected: Skill[]) {
  const needle = query.trim().toLowerCase();
  const selectedPaths = new Set(selected.map((skill) => skill.path));
  return skills
    .filter((skill) => !selectedPaths.has(skill.path))
    .filter((skill) => {
      if (!needle) return true;
      const text = `${skill.name} ${skill.interface?.displayName ?? ""} ${skill.interface?.shortDescription ?? ""} ${skill.description}`.toLowerCase();
      return text.includes(needle);
    })
    .slice(0, 8);
}

export function matchingPlugins(plugins: PluginSummary[], query: string) {
  const needle = query.trim().toLowerCase();
  return plugins
    .filter((plugin) => plugin.installed && plugin.enabled !== false)
    .filter((plugin) => {
      if (!needle) return true;
      const text = `${plugin.name} ${plugin.interface?.displayName ?? ""} ${plugin.interface?.shortDescription ?? ""} ${(plugin.keywords ?? []).join(" ")}`.toLowerCase();
      return text.includes(needle);
    })
    .slice(0, 8);
}

function displayName(skill: Skill) {
  return skill.interface?.displayName || skill.name;
}

export type ProjectFileMention = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
};

function fileSize(size: number | null) {
  if (size === null) return "目录";
  return size < 1024 ? `${size} B` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function SkillMentionMenu({ skills, plugins, files, activeIndex, loading, pluginLoading, fileLoading, error, pluginError, fileError, limitReached, fileLimitReached, onActiveIndexChange, onSelect, onSelectPlugin, onSelectFile, onManage, onManagePlugins }: {
  skills: Skill[];
  plugins: PluginSummary[];
  files: ProjectFileMention[];
  activeIndex: number;
  loading: boolean;
  pluginLoading: boolean;
  fileLoading: boolean;
  error: string;
  pluginError: string;
  fileError: string;
  limitReached: boolean;
  fileLimitReached: boolean;
  onActiveIndexChange: (index: number) => void;
  onSelect: (skill: Skill) => void;
  onSelectPlugin: (plugin: PluginSummary) => void;
  onSelectFile: (file: ProjectFileMention) => void;
  onManage: () => void;
  onManagePlugins: () => void;
}) {
  const visibleSkills = limitReached ? [] : skills;
  const visibleFiles = fileLimitReached ? files.filter((file) => file.type === "directory") : files;
  const optionCount = visibleSkills.length + plugins.length + visibleFiles.length;
  return <div className="skill-mention-menu" role="listbox" aria-label="选择 Skill、插件或项目内容">
    <header><span><AtSign size={15} /><strong>选择 Skill、插件或项目内容</strong></span><small>文件作为附件；目录和插件作为明确上下文</small></header>
    <div className="skill-mention-list">
      {loading && pluginLoading && fileLoading && optionCount === 0 && <div className="skill-mention-state">正在搜索 Skills、插件和项目内容…</div>}
      {!loading && error && <div className="skill-mention-state error">{error}</div>}
      {!pluginLoading && pluginError && <div className="skill-mention-state error">{pluginError}</div>}
      {!fileLoading && fileError && <div className="skill-mention-state error">{fileError}</div>}
      {limitReached && <div className="skill-mention-state compact">本条消息已选择 6 个 Skills，仍可继续选择文件</div>}
      {fileLimitReached && <div className="skill-mention-state compact">本条消息已选择 6 个附件</div>}
      {visibleSkills.length > 0 && <div className="skill-mention-section-label">Skills</div>}
      {visibleSkills.map((skill, index) => <button
        className={index === activeIndex ? "active" : ""}
        key={skill.path}
        role="option"
        aria-selected={index === activeIndex}
        onMouseDown={(event) => { event.preventDefault(); onSelect(skill); }}
        onMouseEnter={() => onActiveIndexChange(index)}
      >
        <span className="skill-icon" style={{ background: skill.interface?.brandColor || undefined }}><Sparkles size={15} /></span>
        <span><strong>{displayName(skill)}</strong><small>{skill.interface?.shortDescription || skill.description || skill.name}</small></span>
        <em>@{skill.name}</em>
      </button>)}
      {plugins.length > 0 && <div className="skill-mention-section-label">已安装插件</div>}
      {plugins.map((plugin, index) => {
        const optionIndex = visibleSkills.length + index;
        return <button className={optionIndex === activeIndex ? "active" : ""} key={plugin.id} role="option" aria-selected={optionIndex === activeIndex} onMouseDown={(event) => { event.preventDefault(); onSelectPlugin(plugin); }} onMouseEnter={() => onActiveIndexChange(optionIndex)}>
          <span className="skill-icon"><Boxes size={15} /></span>
          <span><strong>{plugin.interface?.displayName || plugin.name}</strong><small>{plugin.interface?.shortDescription || plugin.marketplaceName || "已安装插件"}</small></span>
          <em>@{plugin.name}</em>
        </button>;
      })}
      {visibleFiles.length > 0 && <div className="skill-mention-section-label">当前项目文件与目录</div>}
      {visibleFiles.map((file, index) => {
        const optionIndex = visibleSkills.length + plugins.length + index;
        return <button
          className={optionIndex === activeIndex ? "active" : ""}
          key={file.path}
          role="option"
          aria-selected={optionIndex === activeIndex}
          onMouseDown={(event) => { event.preventDefault(); onSelectFile(file); }}
          onMouseEnter={() => onActiveIndexChange(optionIndex)}
        >
          <span className="skill-icon file">{file.type === "directory" ? <Folder size={15} /> : <FileCode2 size={15} />}</span>
          <span><strong>{file.name}</strong><small>{file.path}</small></span>
          <em>{fileSize(file.size)}</em>
        </button>;
      })}
      {!loading && !pluginLoading && !fileLoading && !error && !pluginError && !fileError && optionCount === 0 && <div className="skill-mention-state">没有匹配的 Skill、插件或项目内容</div>}
    </div>
    <footer><span>↑↓ 选择 · Enter 确认 · Esc 关闭</span><div><button onMouseDown={(event) => { event.preventDefault(); onManage(); }}>Skills</button><button onMouseDown={(event) => { event.preventDefault(); onManagePlugins(); }}>插件</button></div></footer>
  </div>;
}
