import { Check, ChevronUp, Folder, FolderOpen, FolderPlus, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Bootstrap } from "../types";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  bootstrap: Bootstrap;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
};

export function ProjectDialog({ open, bootstrap, onClose, onCreated }: Props) {
  const [root, setRoot] = useState(bootstrap.settings.workspaceRoots[0] ?? "");
  const separator = root.includes("\\") ? "\\" : "/";
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [providerId, setProviderId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browser, setBrowser] = useState<{ path: string; parent: string | null; entries: Array<{ name: string; path: string }> } | null>(null);
  const [candidates, setCandidates] = useState<Array<{ path: string; enabled: boolean }>>([]);
  useEffect(() => {
    if (open && !bootstrap.settings.workspaceRoots.includes(root) && !candidates.some((item) => item.path === root)) setRoot(bootstrap.settings.workspaceRoots[0] ?? "");
  }, [open, root, bootstrap.settings.workspaceRoots, candidates]);
  useEffect(() => {
    if (!open) return;
    api<{ data: Array<{ path: string; enabled: boolean }> }>("/api/workspace-roots").then((result) => setCandidates(result.data)).catch(() => setCandidates([]));
  }, [open, bootstrap.settings.workspaceRoots]);
  const suggestedPath = useMemo(() => {
    const slug = name.trim().replace(/[<>:"/\\|?*]+/g, "-").replace(/\s+/g, "-");
    return slug ? `${root.replace(/[\\/]$/, "")}${separator}${slug}` : "";
  }, [name, root, separator]);

  async function browse(target?: string) {
    setBrowsing(true);
    setBrowserLoading(true);
    setError("");
    const requested = target || path.trim() || root;
    try {
      let result;
      try {
        result = await api<{ path: string; parent: string | null; entries: Array<{ name: string; path: string }> }>(`/api/filesystem/browse?path=${encodeURIComponent(requested)}`);
      } catch {
        const settings = await api<{ workspaceRoots: string[] }>("/api/workspace-roots", { method: "POST", body: JSON.stringify({ path: requested }) });
        const activated = settings.workspaceRoots.at(-1) || requested;
        setRoot(activated);
        setPath(activated);
        setCandidates((current) => current.map((candidate) => candidate.path === requested || candidate.path === activated ? { ...candidate, enabled: true } : candidate));
        result = await api<{ path: string; parent: string | null; entries: Array<{ name: string; path: string }> }>(`/api/filesystem/browse?path=${encodeURIComponent(activated)}`);
        await onCreated();
      }
      setBrowser(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "目录读取失败");
      setBrowsing(false);
      setBrowser(null);
    } finally {
      setBrowserLoading(false);
    }
  }

  async function useCandidate(item: { path: string; enabled: boolean }) {
    setError("");
    try {
      if (!item.enabled) {
        await api("/api/workspace-roots", { method: "POST", body: JSON.stringify({ path: item.path }) });
        setCandidates((current) => current.map((candidate) => candidate.path === item.path ? { ...candidate, enabled: true } : candidate));
      }
      setRoot(item.path);
      setPath("");
      await browse(item.path);
      await onCreated();
    } catch (reason) {
      setBrowsing(false);
      setBrowserLoading(false);
      setError(reason instanceof Error ? reason.message : "共享目录启用失败");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="创建新项目" subtitle="项目会绑定一个真实的 NAS 目录，所有会话共享这份文件上下文。">
      <form className="stack-form" onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          if (path.trim()) {
            await api("/api/workspace-roots", { method: "POST", body: JSON.stringify({ path: path.trim() }) });
          }
          await api("/api/projects", {
            method: "POST",
            body: JSON.stringify({
              name,
              path: path.trim() || suggestedPath,
              defaultProviderId: providerId || null,
              create: true,
            }),
          });
          setName("");
          setPath("");
          setProviderId("");
          await onCreated();
          onClose();
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "创建失败");
        } finally {
          setSaving(false);
        }
      }}>
        <label>
          <span>项目名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：个人博客" required />
        </label>
        <label>
          <span>项目目录</span>
          {bootstrap.settings.workspaceRoots.length > 1 && <select value={root} onChange={(event) => { setRoot(event.target.value); setPath(""); setBrowser(null); }}>
            {bootstrap.settings.workspaceRoots.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>}
          <div className="path-picker-row">
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder={suggestedPath || "粘贴飞牛中已授权的绝对目录"} />
            <button type="button" className="secondary-button" disabled={!path.trim() && !root} onClick={() => void browse(path.trim() || root)}><FolderOpen size={16} /> 验证并浏览</button>
          </div>
          <small>可以直接粘贴飞牛里已授权的绝对路径；“验证并浏览”会测试真实的读写权限并自动加入本应用工作区。留空时会在当前共享目录下按项目名称创建文件夹。</small>
          {candidates.length > 0 && <div className="share-candidates"><span>可用共享目录 · 点击后直接从这里浏览</span>{candidates.map((item) => <button type="button" className={item.enabled ? "enabled" : ""} key={item.path} onClick={() => void useCandidate(item)}><FolderPlus size={14} /> <strong>{item.path}</strong><em>{item.enabled ? "已启用" : "启用"}</em></button>)}</div>}
        </label>
        {browsing && (
          <section className="directory-browser">
            <header>
              <button type="button" className="icon-button small" disabled={!browser?.parent || browserLoading} onClick={() => void browse(browser?.parent || undefined)} aria-label="返回上级目录"><ChevronUp size={16} /></button>
              <span title={browser?.path}>{browserLoading ? "正在读取目录…" : browser?.path || "请选择共享目录"}</span>
              {browserLoading && <LoaderCircle className="spin" size={15} />}
            </header>
            <div className="directory-list">
              {!browserLoading && browser?.entries.map((entry) => (
                <button type="button" key={entry.path} onClick={() => void browse(entry.path)}><Folder size={16} /><span>{entry.name}</span></button>
              ))}
              {!browserLoading && browser?.entries.length === 0 && <div className="empty-directory">这个目录中没有子目录</div>}
            </div>
            <footer>
              <button type="button" className="ghost-button" onClick={() => setBrowsing(false)}>取消浏览</button>
              <button type="button" className="secondary-button" disabled={!browser || browserLoading} onClick={() => { if (browser) setPath(browser.path); setBrowsing(false); }}><Check size={15} /> 使用此目录</button>
            </footer>
          </section>
        )}
        <label>
          <span>默认模型供应商</span>
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            <option value="">OpenAI / ChatGPT</option>
            {bootstrap.providers.filter((item) => item.enabled).map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>
            ))}
          </select>
        </label>
        {error && <div className="form-error">{error}</div>}
        <footer className="form-actions">
          <button type="button" className="ghost-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving || !name.trim()}>
            <FolderPlus size={17} /> {saving ? "创建中…" : "创建项目"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
