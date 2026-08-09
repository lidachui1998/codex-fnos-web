import { Archive, LoaderCircle, Pin, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Thread } from "../types";
import { Modal } from "./Modal";

function title(thread: Thread) {
  return thread.name || thread.preview
    ?.replace(/\s*<fnos_attachment[\s\S]*?<\/fnos_attachment>/g, "")
    .replace(/^(?:\$[\w:-]+\s*)+/, "")
    .trim() || "新会话";
}

export function GlobalSearchDialog({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (thread: Thread) => Promise<void> | void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const value = query.trim();
    if (!value) {
      setResults([]);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      api<{ data: Thread[] }>(`/api/threads/search?query=${encodeURIComponent(value)}`, { signal: controller.signal })
        .then((result) => setResults(result.data ?? []))
        .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "搜索失败"); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  return <Modal open={open} onClose={onClose} title="搜索所有会话" subtitle="跨项目搜索当前会话与已归档会话">
    <div className="global-search">
      <label className="global-search-input"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入会话标题或关键词" />{loading && <LoaderCircle size={15} className="spin" />}</label>
      <div className="global-search-results">
        {results.map((thread) => <button key={`${thread.archived ? "archive" : "active"}-${thread.id}`} onClick={async () => { await onSelect(thread); onClose(); }}>
          <span><strong>{title(thread)}</strong><small>{thread.projectName || thread.cwd}</small></span>
          <em>{thread.pinned && <Pin size={12} />}{thread.archived && <><Archive size={12} /> 已归档</>}</em>
        </button>)}
        {!loading && query.trim() && results.length === 0 && !error && <div className="global-search-empty">没有找到匹配的会话</div>}
        {!query.trim() && <div className="global-search-empty">搜索结果会同时包含所有项目和已归档会话</div>}
        {error && <div className="form-error">{error}</div>}
      </div>
    </div>
  </Modal>;
}
