import { AlertTriangle, Bell, CalendarClock, CheckCircle2, ChevronRight, CircleHelp, Clock3, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { NotificationFilter, NotificationItem, NotificationSummary } from "../types";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  revision: number;
  onClose: () => void;
  onOpenThread: (threadId: string, projectId?: string | null) => Promise<void>;
  onSummary: (summary: NotificationSummary) => void;
};

const filters: Array<{ id: NotificationFilter; label: string; count?: keyof NotificationSummary }> = [
  { id: "all", label: "全部" },
  { id: "unread", label: "未读", count: "unread" },
  { id: "running", label: "运行中", count: "running" },
  { id: "failed", label: "失败", count: "failed" },
  { id: "scheduled", label: "定时任务", count: "scheduled" },
];

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp * 1000);
}

function statusMeta(status: NotificationItem["status"]) {
  if (status === "completed") return { label: "已完成", icon: CheckCircle2 };
  if (status === "failed") return { label: "失败", icon: AlertTriangle };
  if (status === "timeout") return { label: "超时", icon: Clock3 };
  if (status === "waiting") return { label: "等待输入", icon: CircleHelp };
  return { label: "运行中", icon: LoaderCircle };
}

export function NotificationCenterDialog({ open, revision, onClose, onOpenThread, onSummary }: Props) {
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [summary, setSummary] = useState<NotificationSummary>({ unread: 0, running: 0, failed: 0, scheduled: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api<{ data: NotificationItem[]; summary: NotificationSummary }>(`/api/notifications?filter=${filter}&limit=150`)
      .then((result) => {
        if (cancelled) return;
        setItems(result.data);
        setSummary(result.summary);
        onSummary(result.summary);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "通知加载失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, filter, revision]);

  async function markAllRead() {
    try {
      const result = await api<{ summary: NotificationSummary }>("/api/notifications/read-all", { method: "POST", body: "{}" });
      setItems((current) => filter === "unread" ? [] : current.map((item) => ({ ...item, read: true })));
      setSummary(result.summary);
      onSummary(result.summary);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "标记已读失败");
    }
  }

  async function openItem(item: NotificationItem) {
    if (!item.read) {
      try {
        const result = await api<{ summary: NotificationSummary }>(`/api/notifications/${item.id}`, {
          method: "PATCH",
          body: JSON.stringify({ read: true }),
        });
        setSummary(result.summary);
        onSummary(result.summary);
      } catch {
        // Opening the task is still useful if marking the notification fails.
      }
    }
    if (item.threadId) {
      try {
        await onOpenThread(item.threadId, item.projectId);
        onClose();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "无法打开这条通知关联的会话");
      }
    } else {
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="通知中心" subtitle="任务状态保存在这台飞牛 NAS 上，外部渠道只发送已启用的事件。" wide>
      <div className="notification-center">
        <div className="notification-toolbar">
          <div className="notification-filters">
            {filters.map((item) => <button key={item.id} className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)}>
              {item.label}{item.count && summary[item.count] > 0 ? <em>{summary[item.count]}</em> : null}
            </button>)}
          </div>
          <button className="mini-button" disabled={summary.unread === 0} onClick={() => void markAllRead()}>全部已读</button>
        </div>
        {error && <div className="form-error">{error}</div>}
        {loading ? <div className="notification-empty"><LoaderCircle className="spin" size={24} /><span>正在加载通知…</span></div> : (
          <div className="notification-list">
            {items.map((item) => {
              const meta = statusMeta(item.status);
              const Icon = meta.icon;
              return <button className={`notification-item ${item.status} ${item.read ? "read" : "unread"}`} key={item.id} onClick={() => void openItem(item)}>
                <span className="notification-status-icon"><Icon className={item.status === "running" ? "spin" : ""} size={18} /></span>
                <span className="notification-item-main">
                  <span className="notification-item-heading"><strong>{item.title}</strong><time>{formatTime(item.updatedAt)}</time></span>
                  <span className="notification-item-meta"><em>{meta.label}</em>{item.source === "scheduled" && <small><CalendarClock size={11} /> 定时任务</small>}</span>
                  {item.message && <span className="notification-message">{item.message}</span>}
                </span>
                <span className="notification-item-action">
                  {!item.read && <i className="unread-dot" aria-label="未读" />}
                  {item.threadId && <><small>打开会话</small><ChevronRight size={15} /></>}
                </span>
              </button>;
            })}
            {items.length === 0 && <div className="notification-empty"><Bell size={28} /><strong>这里还没有通知</strong><span>任务开始、完成、失败、超时或等待输入时会出现在这里。</span></div>}
          </div>
        )}
      </div>
    </Modal>
  );
}
