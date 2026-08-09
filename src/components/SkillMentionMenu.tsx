import { AtSign, Sparkles } from "lucide-react";
import type { Skill } from "../types";

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

function displayName(skill: Skill) {
  return skill.interface?.displayName || skill.name;
}

export function SkillMentionMenu({ skills, activeIndex, loading, error, limitReached, onActiveIndexChange, onSelect, onManage }: {
  skills: Skill[];
  activeIndex: number;
  loading: boolean;
  error: string;
  limitReached: boolean;
  onActiveIndexChange: (index: number) => void;
  onSelect: (skill: Skill) => void;
  onManage: () => void;
}) {
  return <div className="skill-mention-menu" role="listbox" aria-label="强制使用 Skill">
    <header><span><AtSign size={15} /><strong>强制使用 Skill</strong></span><small>未指定时仍会智能选择</small></header>
    <div className="skill-mention-list">
      {loading && skills.length === 0 && <div className="skill-mention-state">正在读取已启用的 Skills…</div>}
      {!loading && error && <div className="skill-mention-state error">{error}</div>}
      {!loading && !error && limitReached && <div className="skill-mention-state">每条消息最多强制使用 6 个 Skills</div>}
      {!loading && !error && !limitReached && skills.map((skill, index) => <button
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
      {!loading && !error && !limitReached && skills.length === 0 && <div className="skill-mention-state">没有匹配的已启用 Skill</div>}
    </div>
    <footer><span>↑↓ 选择 · Enter 确认 · Esc 关闭</span><button onMouseDown={(event) => { event.preventDefault(); onManage(); }}>管理 Skills</button></footer>
  </div>;
}
