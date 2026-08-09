export function changeKindName(kind: unknown) {
  const value = typeof kind === "string"
    ? kind
    : kind && typeof kind === "object" && "type" in kind
      ? String((kind as { type?: unknown }).type ?? "")
      : "";
  if (["add", "added", "untracked"].includes(value)) return value === "untracked" ? "未跟踪" : "新增";
  if (["delete", "deleted"].includes(value)) return "删除";
  if (["update", "modified"].includes(value)) return "修改";
  if (["rename", "renamed"].includes(value)) return "重命名";
  if (["conflict", "conflicted"].includes(value)) return "冲突";
  return value || "变更";
}

export function normalizedChangeKind(kind: unknown) {
  const name = changeKindName(kind);
  if (name === "新增") return "added";
  if (name === "未跟踪") return "untracked";
  if (name === "删除") return "deleted";
  if (name === "重命名") return "renamed";
  if (name === "冲突") return "conflict";
  return "modified";
}

function lineKind(line: string) {
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "context";
}

export function DiffView({ value, className = "" }: { value: unknown; className?: string }) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const lines = text.split("\n");
  return <pre className={`diff-view ${className}`.trim()}><code>{lines.map((line, index) => <span className={`diff-line ${lineKind(line)}`} key={index}>{line}{index < lines.length - 1 ? "\n" : ""}</span>)}</code></pre>;
}
