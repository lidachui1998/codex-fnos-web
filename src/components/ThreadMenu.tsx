import { Archive, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Thread } from "../types";

type Props = {
  thread: Thread;
  disabled?: boolean;
  onRename: (thread: Thread) => void;
  onTogglePin: (thread: Thread) => void;
  onArchive: (thread: Thread) => void;
  onRestore: (thread: Thread) => void;
  onDelete: (thread: Thread) => void;
};

export function ThreadMenu({ thread, disabled, onRename, onTogglePin, onArchive, onRestore, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const run = (action: (value: Thread) => void) => {
    setOpen(false);
    action(thread);
  };
  return <div className="thread-menu-wrap">
    <button className="thread-menu-button" disabled={disabled} onClick={() => setOpen((value) => !value)} aria-label="会话操作" aria-expanded={open}><MoreHorizontal size={15} /></button>
    {open && <>
      <button className="thread-menu-scrim" onClick={() => setOpen(false)} aria-label="关闭会话菜单" />
      <div className="thread-menu" role="menu">
        {!thread.archived && <button onClick={() => run(onRename)}><Pencil size={14} />重命名</button>}
        {!thread.archived && <button onClick={() => run(onTogglePin)}>{thread.pinned ? <PinOff size={14} /> : <Pin size={14} />}{thread.pinned ? "取消置顶" : "置顶"}</button>}
        {thread.archived
          ? <button onClick={() => run(onRestore)}><RotateCcw size={14} />恢复到会话列表</button>
          : <button onClick={() => run(onArchive)}><Archive size={14} />归档</button>}
        <button className="danger" onClick={() => run(onDelete)}><Trash2 size={14} />删除</button>
      </div>
    </>}
  </div>;
}
