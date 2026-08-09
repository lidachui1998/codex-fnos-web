import { Check, Eye, LoaderCircle, RefreshCw, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { Project, Skill, SkillsResult } from "../types";
import { Modal } from "./Modal";

const scopeNames = { user: "个人", repo: "项目", system: "系统", admin: "管理员" } as const;

function displayName(skill: Skill) {
  return skill.interface?.displayName || skill.name;
}

export function SkillsDialog({ open, project, selected, revision, onSelectedChange, onClose }: {
  open: boolean;
  project: Project | null;
  selected: Skill[];
  revision: number;
  onSelectedChange: (skills: Skill[]) => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<SkillsResult>({ cwd: "", skills: [], errors: [] });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<{ skill: Skill; content: string } | null>(null);

  async function load(reload = false) {
    if (!project) return;
    setLoading(true); setError("");
    try {
      const next = await api<SkillsResult>(`/api/projects/${project.id}/skills${reload ? "?reload=1" : ""}`);
      setResult(next);
      const enabledPaths = new Set(next.skills.filter((item) => item.enabled).map((item) => item.path));
      onSelectedChange(selected.filter((item) => enabledPaths.has(item.path)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Skills 读取失败");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (open && project) void load(revision > 0);
    if (!open) { setDetail(null); setError(""); }
  }, [open, project?.id, revision]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return result.skills;
    return result.skills.filter((skill) => `${skill.name} ${displayName(skill)} ${skill.description}`.toLowerCase().includes(needle));
  }, [query, result.skills]);

  async function toggleEnabled(skill: Skill) {
    if (!project) return;
    setBusyPath(skill.path); setError("");
    try {
      const next = await api<SkillsResult>(`/api/projects/${project.id}/skills`, {
        method: "PATCH",
        body: JSON.stringify({ path: skill.path, enabled: !skill.enabled }),
      });
      setResult(next);
      if (skill.enabled) onSelectedChange(selected.filter((item) => item.path !== skill.path));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Skill 设置失败"); }
    finally { setBusyPath(""); }
  }

  function toggleSelected(skill: Skill) {
    if (!skill.enabled) return;
    onSelectedChange(selected.some((item) => item.path === skill.path)
      ? selected.filter((item) => item.path !== skill.path)
      : [...selected, skill].slice(0, 6));
  }

  async function openDetail(skill: Skill) {
    if (!project) return;
    setBusyPath(skill.path); setError("");
    try {
      setDetail(await api<{ skill: Skill; content: string }>(`/api/projects/${project.id}/skills/detail?path=${encodeURIComponent(skill.path)}`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Skill 详情读取失败"); }
    finally { setBusyPath(""); }
  }

  return <Modal open={open} title="Skills" subtitle={project ? `管理 ${project.name} 可用的 Codex Skills，并选择下一条消息要调用的能力。` : "请先选择项目"} onClose={onClose} wide>
    <div className="skills-toolbar">
      <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或用途" /></label>
      <button className="secondary-button compact" disabled={!project || loading} onClick={() => void load(true)}><RefreshCw size={14} className={loading ? "spin" : ""} /> 刷新</button>
    </div>
    {error && <div className="settings-error">{error}</div>}
    {result.errors.length > 0 && <div className="settings-warning">{result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}</div>}
    {detail ? <div className="skill-detail">
      <header><button className="secondary-button compact" onClick={() => setDetail(null)}>返回列表</button><span><strong>{displayName(detail.skill)}</strong><small>{detail.skill.path}</small></span></header>
      <div className="skill-markdown markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.content}</ReactMarkdown></div>
    </div> : <div className="skills-list">
      {visible.map((skill) => {
        const chosen = selected.some((item) => item.path === skill.path);
        return <article className={`skill-card ${chosen ? "selected" : ""} ${skill.enabled ? "" : "disabled"}`} key={skill.path}>
          <button className="skill-main" onClick={() => toggleSelected(skill)} disabled={!skill.enabled}>
            <span className="skill-icon" style={{ background: skill.interface?.brandColor || undefined }}><Sparkles size={17} /></span>
            <span><strong>{displayName(skill)}</strong><small>{skill.interface?.shortDescription || skill.description || "暂无说明"}</small><em>{scopeNames[skill.scope] || skill.scope} · {skill.name}</em></span>
            {chosen && <i><Check size={14} /> 已选择</i>}
          </button>
          <div className="skill-actions"><button className="icon-button small" onClick={() => void openDetail(skill)} title="查看 SKILL.md"><Eye size={14} /></button><label><span>{skill.enabled ? "已启用" : "已停用"}</span><input type="checkbox" checked={skill.enabled} disabled={busyPath === skill.path} onChange={() => void toggleEnabled(skill)} />{busyPath === skill.path && <LoaderCircle size={13} className="spin" />}</label></div>
        </article>;
      })}
      {visible.length === 0 && !loading && <div className="skills-empty">没有找到 Skill。你可以在 Codex Home 的 skills 目录或项目的 `.agents/skills` 中添加。</div>}
    </div>}
    <div className="skills-footer"><span>可用 {result.skills.filter((item) => item.enabled).length} · 已为下一条消息选择 {selected.length}/6</span><button className="primary-button" onClick={onClose}>完成</button></div>
  </Modal>;
}
